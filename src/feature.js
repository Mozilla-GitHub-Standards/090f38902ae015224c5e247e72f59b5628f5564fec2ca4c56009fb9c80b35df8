/* global TabRecords, VARIATIONS */

// Constants for the page_reloaded_survey telemetry probe.
const SURVEY_SHOWN = 1;
const SURVEY_PAGE_BROKEN = 2;
const SURVEY_PAGE_NOT_BROKEN = 3;
// We only ask the user once per etld+1, so we make sure
// to send along the previous response of the user.
const SURVEY_PREVIOUSLY_BROKEN = 4;
const SURVEY_PREVIOUSLY_NOT_BROKEN = 5;
// We don't want to nag the user about this too much,
// so we ask only once per tab. If the survey was hidden
// because of that, make sure to mark it in the payload.
const SURVEY_HIDDEN = 6;

class Feature {
  constructor() {}

  async configure(studyInfo) {
    let { variation } = studyInfo;

    // The userid will be used to create a unique hash
    // for the etld + userid combination.
    let {userid} = await browser.storage.local.get("userid");
    if (!userid) {
      userid = this.generateUUID();
      await browser.storage.local.set({userid});
    }
    this.userid = userid;

    variation = VARIATIONS[variation.name];

    for (const pref in variation.prefs) {
      browser.prefs.registerPrefCleanup(pref);

      const value = variation.prefs[pref];
      if (typeof value === "boolean") {
        browser.prefs.setBoolPref(pref, value);
      } else if (typeof value === "string") {
        browser.prefs.setStringPref(pref, value);
      } else if (typeof value === "number") {
        browser.prefs.setIntPref(pref, value);
      }
    }

    // Initialize listeners in privileged code.
    browser.trackers.init();

    // Listen for the page to load to show the "is this page broken?"
    // survey for the previous (reloaded) page.
    browser.trackers.onPageDOMContentLoaded.addListener((tabId) => {
      const tabInfo = TabRecords.getTabInfo(tabId);
      if (tabInfo && tabInfo.payloadWaitingForSurvey) {
        this.possiblyShowNotification(tabInfo);
      }
    });

    // When a tab is removed, make sure to submit telemetry for the
    // last page and delete the tab entry.
    browser.tabs.onRemoved.addListener(tabId => {
      const tabInfo = TabRecords.getTabInfo(tabId);
      if (!tabInfo) {
        return;
      }

      if (tabInfo.payloadWaitingForSurvey) {
        this.submitPayloadWaitingForSurvey(tabInfo);
      }

      // Only submit telemetry if we have recorded load info and
      // the tab actually has trackers.
      if (tabInfo.telemetryPayload.etld) {
        this.sendTelemetry(tabInfo.telemetryPayload);
      }

      TabRecords.deleteTabEntry(tabId);
    });

    // We receive most of the critical site information in beforeunload
    // and send it either on unload or on tab close.
    browser.trackers.onPageBeforeUnload.addListener(async (tabId, data) => {
      if (tabId < 0 || !data.etld) {
        return;
      }

      const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
      await this.addMainTelemetryData(tabInfo, data, userid);
    });

    // On unload, submit telemetry and reset.
    browser.trackers.onPageUnload.addListener(async (tabId, data) => {
      if (tabId < 0 || !data.etld) {
        return;
      }

      // The tab we are dealing with might have been unloaded because
      // it was closed. In this case the onRemoved handler will
      // deal with submitting telemetry.
      try {
        await browser.tabs.get(tabId);
      } catch (e) {
        return;
      }

      const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
      // On unload we also try to record data that might not have
      // survived onbeforeunload.
      await this.addMainTelemetryData(tabInfo, data, userid);

      if (tabInfo.payloadWaitingForSurvey) {
        this.submitPayloadWaitingForSurvey(tabInfo);
      }

      if (tabInfo.telemetryPayload.page_reloaded) {
        tabInfo.payloadWaitingForSurvey = Object.assign({}, tabInfo.telemetryPayload);

        tabInfo.reloadCount++;
      } else {
        this.sendTelemetry(tabInfo.telemetryPayload);

        // Reset survey count when no longer refreshing
        tabInfo.reloadCount = 0;
      }

      TabRecords.resetPayload(tabId);
    });

    // Record when users submitted a breakage report in the control center.
    browser.trackers.onReportBreakage.addListener(
      tabId => {
        if (tabId < 0) {
          return;
        }

        const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
        tabInfo.telemetryPayload.user_reported_page_breakage = true;
      }
    );

    browser.trackers.onAddException.addListener(tabId => {
      if (tabId < 0) {
        return;
      }
      const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
      tabInfo.telemetryPayload.user_added_exception = true;
    });

    // Watch for the user pressing the "Yes this page is broken"
    // button and record the answer.
    browser.popupNotification.onReportPageBroken.addListener(
      tabId => {
        const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
        if (!tabInfo || !tabInfo.payloadWaitingForSurvey) {
          return;
        }

        tabInfo.payloadWaitingForSurvey.page_reloaded_survey = SURVEY_PAGE_BROKEN;
        this.recordSurveyInteraction(tabInfo, SURVEY_PREVIOUSLY_BROKEN);
        this.submitPayloadWaitingForSurvey(tabInfo);
      },
    );

    // Watch for the user pressing the "No this page is not broken"
    // button and record the answer.
    browser.popupNotification.onReportPageNotBroken.addListener(
      tabId => {
        const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
        if (!tabInfo || !tabInfo.payloadWaitingForSurvey) {
          return;
        }

        tabInfo.payloadWaitingForSurvey.page_reloaded_survey = SURVEY_PAGE_NOT_BROKEN;
        this.recordSurveyInteraction(tabInfo, SURVEY_PREVIOUSLY_NOT_BROKEN);
        this.submitPayloadWaitingForSurvey(tabInfo);
      },
    );

    browser.trackers.onErrorDetected.addListener(
      (error, tabId) => {
        this.recordPageError(error, tabId);
      }
    );
  }

  submitPayloadWaitingForSurvey(tabInfo) {
    this.sendTelemetry(tabInfo.payloadWaitingForSurvey);
    tabInfo.payloadWaitingForSurvey = null;
  }

  async addMainTelemetryData(tabInfo, data, userid) {
    tabInfo.telemetryPayload.user_has_tracking_protection_exception =
      data.user_has_tracking_protection_exception;
    for (const key in data.performanceEvents) {
      tabInfo.telemetryPayload[key] = data.performanceEvents[key];
    }

    const hash = await this.SHA256(userid + data.etld);
    tabInfo.telemetryPayload.etld = hash;

    tabInfo.telemetryPayload.num_blockable_trackers = data.trackersFound;
    tabInfo.telemetryPayload.num_trackers_blocked = data.trackersBlocked;
    tabInfo.telemetryPayload.page_reloaded = data.pageReloaded || false;
  }

  recordSurveyInteraction(tabInfo, response) {
    browser.storage.local.set({[tabInfo.payloadWaitingForSurvey.etld]: response});
  }

  recordPageError(error, tabId) {
    const tabInfo = TabRecords.getOrInsertTabInfo(tabId);
    if (`num_${error}` in tabInfo.telemetryPayload) {
      tabInfo.telemetryPayload[`num_${error}`] += 1;
    }
  }

  // Adapted from https://gist.github.com/jed/982883
  generateUUID() {
    const randomNumbers = window.crypto.getRandomValues(new Uint8Array(32)).values();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, a =>
      (a ^ randomNumbers.next().value & 0b1111 >> a / 4).toString(16)
    );
  }

  SHA256(message) {
    // encode as UTF-8
    const msgBuffer = new TextEncoder("utf-8").encode(message);
    // hash the message
    return crypto.subtle.digest("SHA-256", msgBuffer).then((hash) => {
      // convert ArrayBuffer to Array
      const hashArray = Array.from(new Uint8Array(hash));
      // convert bytes to hex string
      const hashHex = hashArray.map(b => ("00" + b.toString(16)).slice(-2)).join("");
      return hashHex;
    });
  }

  // Start at 40% chance of showing the notification,
  // increment by 10% until at 6 times, then it is guaranteed.
  // Never show the popup again on the same site if the popup has been interacted with.
  // If the popup is ignored, do not show it while the user continues refreshing
  // but reset upon navigation and possibly show again. The popup can show again on the
  // same site and page if it was ignored.
  async possiblyShowNotification(tabInfo) {
    const payload = tabInfo.payloadWaitingForSurvey;

    const storedEtld = await browser.storage.local.get(payload.etld);
    if (storedEtld[payload.etld]) {
      payload.page_reloaded_survey = storedEtld[payload.etld];
      this.submitPayloadWaitingForSurvey(tabInfo);
      return;
    }

    if (tabInfo.surveyShown) {
      if (!payload.page_reloaded_survey) {
        payload.page_reloaded_survey = SURVEY_HIDDEN;
      }
      this.submitPayloadWaitingForSurvey(tabInfo);
      return;
    }

    const num = Math.floor(Math.random() * 10);
    if (num <= (3 + tabInfo.reloadCount)) {
      payload.page_reloaded_survey = SURVEY_SHOWN;
      tabInfo.surveyShown = true;
      browser.popupNotification.show();
    }
  }

  /**
   * Takes a flat JSON object, converts all values to strings and
   * submits it to Shield telemetry.
   */
  async sendTelemetry(payload) {
    const stringToStringMap = {};
    // Report these prefs with each telemetry ping.
    payload.browser_contentblocking_enabled = await browser.prefs.getBoolPref("browser.contentblocking.enabled");
    payload.browser_fastblock_enabled = await browser.prefs.getBoolPref("browser.fastblock.enabled");
    payload.privacy_trackingprotection_enabled = await browser.prefs.getBoolPref("privacy.trackingprotection.enabled");

    // Shield Telemetry deals with flat string-string mappings.
    for (const key of Object.keys(payload)) {
      stringToStringMap[key] = payload[key].toString();
    }

    browser.study.sendTelemetry(stringToStringMap);
  }

  /**
   * Called at end of study, and if the user disables the study or it gets uninstalled by other means.
   */
  async cleanup() {
    // This is not triggering properly, see
    // https://github.com/mozilla/shield-studies-addon-utils/issues/246
  }
}

// make an instance of the feature class available to background.js
// construct only. will be configured after setup
window.feature = new Feature();
