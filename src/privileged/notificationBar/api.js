"use strict";

/* global ExtensionAPI */

ChromeUtils.import("resource://gre/modules/Console.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm");
ChromeUtils.import("resource://gre/modules/ExtensionUtils.jsm");

var {Management: {global: {tabTracker}}} = ChromeUtils.import("resource://gre/modules/Extension.jsm", {});

// eslint-disable-next-line no-undef
XPCOMUtils.defineLazyModuleGetter(
  this,
  "BrowserWindowTracker",
  "resource:///modules/BrowserWindowTracker.jsm",
);

/** Return most recent NON-PRIVATE browser window, so that we can
 * manipulate chrome elements on it.
 */
function getMostRecentBrowserWindow() {
  return BrowserWindowTracker.getTopWindow({
    private: false,
    allowPopups: false,
  });
}

/** Display instrumented 'notification bar' explaining the feature to the user
 *
 *   Telemetry Probes:
 *
 *   - {event: survey-shown}
 *
 *   - {event: page-broken}
 *
 *   - {event: page-not-broken}
 *
 *    Note:  Bar WILL NOT SHOW if the only window open is a private window.
 *
 *    Note:  Handling of 'x' is not implemented.  For more complete implementation:
 *
 *      https://github.com/gregglind/57-perception-shield-study/blob/680124a/addon/lib/Feature.jsm#L148-L152
 *
 */
 // eslint-disable-next-line no-undef
class NotificationBarEventEmitter extends EventEmitter {
  emitShow(variationName) {
    const self = this;
    const recentWindow = getMostRecentBrowserWindow();
    const doc = recentWindow.document;

    let browser = recentWindow.gBrowser.selectedBrowser;
    let tabId = tabTracker.getBrowserTabId(browser);

    const primaryAction =  {
      label: "Yes!",
      accessKey: "f",
      callback: () => {
        self.emit("page-broken", {tabId});
      },
    };

    const secondaryActions =  [
      {
        label: "Nope",
        accessKey: "d",
        callback: () => {
          self.emit("page-not-broken", {tabId});
        },
      },
    ];

    const populatePanel = (event) => {
      // console.log("EVENT HAPPENED", event);
      // Can edit the contents of the panel here if we want variations per branch
      // if (event !== "shown") {
      //   return;
      // }
    };

    doc.defaultView.PopupNotifications.show(browser, "fast-block-notification", "Is this page broken?", null, primaryAction, secondaryActions, {eventCallback: populatePanel});
  }
}

this.notificationBar = class extends ExtensionAPI {
  /**
   * Extension Shutdown
   * APIs that allocate any resources (e.g., adding elements to the browser’s user interface,
   * setting up internal event listeners, etc.) must free these resources when the extension
   * for which they are allocated is shut down.
   */
  onShutdown(shutdownReason) {
    console.log("onShutdown", shutdownReason);
    // TODO: remove any active ui
  }

  getAPI(context) {
    const notificationBarEventEmitter = new NotificationBarEventEmitter();
    return {
      notificationBar: {
        show() {
          notificationBarEventEmitter.emitShow();
        },
        // eslint-disable-next-line no-undef
        onReportPageBroken: new EventManager(
          context,
          "notificationBar.onReportPageBroken",
          fire => {
            const listener = (value, {tabId}) => {
              fire.async(tabId);
            };
            notificationBarEventEmitter.on(
              "page-broken",
              listener,
            );
            return () => {
              notificationBarEventEmitter.off(
                "page-broken",
                listener,
              );
            };
          },
        ).api(),
        // eslint-disable-next-line no-undef
        onReportPageNotBroken: new EventManager(
          context,
          "notificationBar.onReportPageNotBroken",
          fire => {
            const listener = (value, {tabId}) => {
              fire.async(tabId);
            };
            notificationBarEventEmitter.on(
              "page-not-broken",
              listener,
            );
            return () => {
              notificationBarEventEmitter.off(
                "page-not-broken",
                listener,
              );
            };
          },
        ).api(),
      },
    };
  }
};
