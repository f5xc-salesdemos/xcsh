# Platform-specific native addon packages

These directories contain platform-specific npm packages for `@f5xc-salesdemos/pi-natives`.
Each package ships the pre-built `.node` binary for its target platform.

When users install `@f5xc-salesdemos/pi-natives` (or `@f5xc-salesdemos/xcsh`), npm/bun
automatically installs only the matching platform package via `optionalDependencies`.

The `.node` binary files are NOT committed to git — they are built by CI and placed here
before publishing. Only the `package.json` templates are in version control.

## Packages

| Package | Platform | CPU | Variants |
|---------|----------|-----|----------|
| `@f5xc-salesdemos/pi-natives-linux-x64-gnu` | Linux | x64 | baseline, modern |
| `@f5xc-salesdemos/pi-natives-linux-arm64-gnu` | Linux | arm64 | default |
| `@f5xc-salesdemos/pi-natives-darwin-x64` | macOS | x64 | baseline, modern |
| `@f5xc-salesdemos/pi-natives-darwin-arm64` | macOS | arm64 | default |
| `@f5xc-salesdemos/pi-natives-win32-x64-msvc` | Windows | x64 | baseline, modern |
