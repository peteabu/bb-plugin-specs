# Vendored Hugeicons artwork

Source: [@hugeicons/core-free-icons 4.3.5](https://www.npmjs.com/package/@hugeicons/core-free-icons/v/4.3.5), Free Stroke Rounded, MIT.
Archive: https://registry.npmjs.org/@hugeicons/core-free-icons/-/core-free-icons-4.3.5.tgz

The SVG elements in components/ui/icon.tsx are copied from the standalone modules
listed below. Geometry, stroke width (1.5), caps, and joins are unchanged; only
upstream array/key bookkeeping is replaced with static JSX. The SVG viewport is
24 × 24. Preserve the accompanying LICENSE.md when redistributing.

These are checked-in source assets, not an install-time dependency. Do not import
the package barrel: earlier versions referenced case-mismatched filenames and
broke Linux managed installs. When updating, copy only the required official
modules from an exact release and verify a clean Linux production-only install.

| Local name | Upstream module |
| --- | --- |
| Archive | Archive03Icon.js |
| Beaker | FlaskConicalIcon.js |
| Check | Tick02Icon.js |
| ChevronDown | ArrowDown01Icon.js |
| ChevronLeft | ArrowLeft01Icon.js |
| ChevronRight | ArrowRight01Icon.js |
| CircleCheck | CheckmarkCircle02Icon.js |
| Copy | Copy01Icon.js |
| Edit | Edit02Icon.js |
| FileText | File02Icon.js |
| Folder | Folder02Icon.js |
| Loading | Loading03Icon.js |
| MessageCirclePlus | BubbleChatAddIcon.js |
| MessageQuestion | MessageQuestionIcon.js |
| MessageSquare | BubbleChatIcon.js |
| NewTab | LinkSquare02Icon.js |
| Plus | Add01Icon.js |
| Search | Search01Icon.js |
| Target | Target02Icon.js |
| Trash2 | Delete02Icon.js |
| X | Cancel01Icon.js |
| Zap | ZapIcon.js |

Archive SHA-256: `c95cc346815518a2a9f91edf8c194d497ba6e4e3ecb3f20a38e034f72d756b5f`.

Verified in a fresh Node 20 Alpine container using
`npm install --ignore-scripts --omit=dev`, followed by frontend bundling with
esbuild (development dependencies, including BB-provided host modules, external).
The native `bb plugin build` was also verified on macOS. This is a Linux
production-install/bundling check, not a marketplace admission test on a Linux BB
server. Icons were rendered at 14, 16, 20, and 24px for visual inspection.
