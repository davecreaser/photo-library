# A desktop app built with Electron, not a web app

The owner wanted a locally running app with a native window rather than a browser UI, built in Node. Electron gives that, with direct file access in the main process and one codebase for macOS, Windows and Linux. A local web server opened in a browser was explicitly rejected by the owner. Tauri was not chosen because the photo pipeline (sharp, exifr, onnxruntime) is Node-native.
