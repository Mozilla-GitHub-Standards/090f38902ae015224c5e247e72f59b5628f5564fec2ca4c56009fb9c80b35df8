const defaultConfig = {
  // Global options:
  verbose: true,
  sourceDir: './src/',
  artifactsDir: './dist/',
  ignoreFiles: [
    '.DS_Store',
  ],
  // Command options:
  build: {
    overwriteDest: true,
  },
  run: {
    firefox: 'nightly',
    browserConsole: true,
    startUrl: ['about:debugging'],
  },
};

module.exports = defaultConfig;