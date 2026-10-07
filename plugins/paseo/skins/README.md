# Paseo Skins

Browse and install background skins from the [paseo-skins catalog](https://huangguang1999.github.io/paseo-skins/) inside Paseo. Installed skins appear in **Settings → Appearance → Background** and can be chosen there like any other skin.

- Supported Paseo: `>=0.10.1` to load the plugin. Skin support needs a Paseo build that provides `client.addSkin` / `client.applySkin`; older apps show "This Paseo version does not support skins" on the settings screen and register nothing.
- Target daemon: the one that should own the downloads and the image files. Skins are served to every connected app from that daemon.

## Install

```bash
paseo plugin install /Users/khangnguyen/git/agent-scripts/plugins/paseo/skins
```

Reload plugins (or restart the daemon) if the plugin does not appear. Remove or disable it from **Settings → Plugins** or with `paseo plugin` (see `paseo plugin --help`). Removing the plugin does not delete downloaded images; delete the data directory below for that.

## Use

Open **Settings → Skin catalog**:

- Search by name, author, or tag; filter Light / Dark / All.
- **Install & use** downloads the skin to the daemon, registers it with Paseo, and applies it on this device. **Use** re-applies an installed skin; **Remove** deletes it from the daemon and unregisters it.
- Each card shows license and a link to the source. Previews are generated on the daemon (≤512×288 JPEG cropped around the skin's focal point) so the grid never downloads full originals into the app.

## Licensing caveat

The catalog images keep their upstream licenses and are **not** all redistributable. Many are personal-use or all-rights-reserved, and many depict anime or game characters. By default the catalog only lists permissive licenses (MIT, CC0, CC BY and CC BY-SA, Pixabay, Unsplash, Public Domain, matched case-insensitively). Everything else (All Rights Reserved, Personal Use, Proprietary, NC/ND variants, unrecognized strings) is hidden until you turn on **Show all licenses**. Installing a skin copies the image to your own machine for your own use; check the license before sharing or publishing screenshots.

## What the daemon does

Server code is trusted and unsandboxed. It:

- Fetches `catalog.json` (15 s timeout, 1 MiB cap) and caches it in memory and on disk for 6 hours; a stale copy is served when offline.
- Installs over HTTPS only. The manifest and image must live under the catalog's directory on the same host; redirects must stay on the host and on HTTPS. Limits: 15 s timeout, 64 KiB manifest, 16 MiB image.
- Verifies the image's SHA-256, byte count and pixel dimensions against the manifest (and ≤16384 px per side, ≤50 MP) before storing anything.
- Measures the luminance of the darkest and brightest 1% of pixels from a downscaled decode so Paseo can let more of the art show without losing text contrast. WebP originals cannot be decoded here, so they carry no luminance and Paseo assumes pure black and white.
- Writes every file atomically (temporary file, then rename).

### Data directory

`$PASEO_HOME/plugin-data/paseo-skins/` when `PASEO_HOME` is set in the daemon's environment, otherwise `~/.paseo/plugin-data/paseo-skins/`:

```text
catalog.json            cached catalog
skins/<id>/skin.json    installed record (name, appearance, focal, intensity, luminance, attribution)
skins/<id>/image.<ext>  verified original
thumbs/                 generated previews
```

### RPCs

| Name | Input | Output |
| --- | --- | --- |
| `skins.catalog_list` | `query?`, `appearance?`, `licenseFilter` (`permissive`\|`all`), `page`, `pageSize` ≤ 24 | entries, total, page, pageCount, fetchedAt, stale |
| `skins.catalog_thumbnail` | `id` | `{ base64, mimeType }` |
| `skins.install` | `id` | installed record |
| `skins.list` | none | installed records |
| `skins.image` | `id` | `{ base64, mimeType }` of the stored original |
| `skins.remove` | `id` | `{ removed }` |

Thumbnails are decoded with the pure-JS `jpeg-js` and `pngjs`; at most two jobs run at once. A WebP original is returned unchanged only when it is ≤1.5 MiB; larger ones show "Preview unavailable".

## Development

```bash
npm install
npm run typecheck
npm test
```

`@getpaseo/plugin` is linked from a local Paseo checkout (`file:/Users/khangnguyen/git/paseo-app-skins/packages/plugin`) because the published SDK does not yet have `addSkin`. `zod` is pinned to the version that checkout uses; a different `zod` makes `tsc` run out of memory comparing two copies of its types. Switch both to the released versions once a Paseo release ships the skin API.
