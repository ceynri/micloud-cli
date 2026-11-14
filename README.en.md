English | [简体中文](./README.md)

# mi-recording-cli

A command-line tool for Xiaomi Cloud recordings (i.mi.com/record): list, search, stats, play online, download, **incrementally pull** to a local folder, delete, and restore or purge from the trash. It covers everything the web recording page can do and is **designed for AI agents and scripts** (uniform `--json` output, fast failure in non-interactive mode).

Typical use: regularly pull the recordings your phone syncs to the cloud, hand them to a transcription pipeline, then clean up the cloud copies.

> ⚠️ **Experimental**: minor releases (`x.Y.z`) may contain breaking changes. Pin the minor version (e.g. `~0.1.0`) if you need stability.

## Features

- **Auth**: interactive browser login with cached, silently renewed sessions; if [mi-note-cli](https://github.com/ceynri/mi-note-cli) is already logged in on this machine, its session is imported read-only on first use
- **Browse**: list (filter by type / time / keyword, sort), search, details, stats by type / month / year
- **Download**: incremental `pull` (resumable, SHA-1 verified, concurrent, filename templates), `download` by id (can stream to a pipe), temporary direct `url`, `play` in the default player
- **Clean up**: move to trash by id, by filter, or "already pulled and verified"; `pull --delete-cloud` cleans up right after pulling
- **Trash**: list, restore, purge
- **AI friendly**: global `--json`; never opens a browser in non-interactive mode; destructive operations require an explicit `-y`

## Install

```bash
npm install -g mi-recording-cli
```

> Requires Node.js >= 18. Playwright is only used to open a browser for login / renewal and prefers the system Chrome; otherwise run `npx playwright install chromium`.

As an AI skill:

```bash
npx -y skills add ceynri/mi-recording-cli --all
```

## Quick start

```bash
mi-recording-cli login                            # 1. log in (opens a browser)
mi-recording-cli list --limit 20                  # 2. 20 most recent recordings
mi-recording-cli pull -o ./recordings             # 3. incremental pull
mi-recording-cli delete --pulled -o ./recordings  # 4. move pulled recordings to the cloud trash
```

## Commands

| Command | Description |
|---|---|
| `login` / `logout` / `whoami` | Log in / clear the session / account and storage usage |
| `list` (`ls`) | List recordings; filters, `--sort time\|size\|duration`, `--asc`, `--limit` |
| `search <keywords...>` | Search titles, contacts, numbers, source apps |
| `info <id>` | Recording details (also looks in the trash) |
| `stats [--by type\|month\|year]` | Count, duration and size statistics |
| `pull` | Incremental pull into a local folder |
| `download <id...>` (`dl`) | Download by id into the current dir or `-o`; `--stdout` streams to a pipe |
| `url <id...>` | Temporary direct link (no login needed, valid for a few hours) |
| `play <id>` | Play in the default player / browser |
| `delete [id...]` (`rm`) | Move to trash: by id, `--pulled` (optionally `--allow-moved`), filters or `--all` |
| `trash [list]` / `trash restore` / `trash purge` | Trash: list / restore / delete permanently |
| `config [show]` / `config set` / `config unset` | Project configuration |

Filters (shared by `list` / `search` / `stats` / `pull` / `delete`):

| Option | Description |
|---|---|
| `-t, --type` | `recorder` / `phonecall` / `fm` / `app` (WeChat, WeCom, ...), comma separated |
| `--since` / `--until` | Recording time: `2026-07-01`, `2026-07-01 18:30`, `7d` / `12h` / `2w` (ago), `today`, `yesterday`; a date-only `--until` includes that day |
| `-q, --query` | Keywords, space separated, all must match |

## Incremental pull

```bash
mi-recording-cli pull -o ./recordings
mi-recording-cli pull --since 7d --type recorder --dry-run
mi-recording-cli pull --delete-cloud -y
```

- **Incremental**: `.mi-recording-cli.state.json` in the pull folder records pulled recordings; later pulls skip them **even if you moved or deleted the local files**. Use `--force` or `download <id>` to fetch again.
- **Integrity**: each file is written to `.part` and only moved into place once its size and SHA-1 match the cloud; interrupted pulls **resume**. Expired links and network errors are retried.
- **Never overwrites**: an identical existing file is adopted; a different file with the same name is kept and the new one is saved as `<name>_<id>`.
- **Exclusive**: only one `pull` / `delete --pulled` can run on a pull folder at a time.
- File modification times are set to the recording time on the phone.
- `--limit n` pulls only the newest n; `-c, --concurrency` sets parallel downloads (1–8, default 3).

### Cleaning up the cloud

Both options only **move recordings to the trash**:

- `pull --delete-cloud`: trashes recordings pulled and verified in this run, plus previously pulled ones that can still be verified.
- `delete --pulled`: a separate cleanup step; filters can be combined.

"Can still be verified" means the cloud size and SHA-1 match the pull, **and the file in the pull folder is still there and unchanged**. If you have moved the files elsewhere (e.g. into a transcription project), the cloud copy is kept by default so the recording never ends up missing on both sides; pass `--allow-moved` once you know the files are safe, and the pull record is trusted instead:

```bash
mi-recording-cli pull -o ./recordings
# move / transcribe the files...
mi-recording-cli delete --pulled -o ./recordings --allow-moved --dry-run
mi-recording-cli delete --pulled -o ./recordings --allow-moved -y
```

A recording that this tool trashed and you later restored is treated as intentionally kept and won't be trashed automatically again (you can still delete it by id). Recordings that were not deleted are listed with reasons (`data.deleteSkipped` / `data.skipped` in JSON).

> ⚠️ Deleting in Xiaomi Cloud **also deletes the recording on devices signed in to the account** (the web page warns about this too). The trash keeps recordings for 30 / 60 / 90 / 180 days depending on membership.

### Filename templates

By default files keep the phone's recording name. Customize with `--template` or the `fileNameTemplate` setting (no extension; `/` creates subfolders):

| Placeholder | Meaning |
|---|---|
| `${title}` | Recording name on the phone (default) |
| `${YYYY}` `${YY}` `${MM}` `${DD}` `${HH}` `${mm}` `${ss}` | Recording start time (local time zone) |
| `${type}` / `${typeName}` | `recorder` etc. / Chinese type name |
| `${contact}` | Call or app peer (name or number) |
| `${phone}` | Phone number |
| `${app}` | Source app (WeChat / WeCom) |
| `${duration}` | Duration in seconds |
| `${id}` | Recording id |

A conditional segment `[...]` is only rendered when every variable inside is non-empty:

```bash
mi-recording-cli config set fileNameTemplate '${type}/${YYYY}-${MM}/${YYYY}${MM}${DD}_${HH}${mm}[_${contact}]'
```

## Piping into other tools

```bash
mi-recording-cli pull --json | jq -r '.data.pulled[].file' | while read -r f; do ./transcribe.sh "$f"; done
mi-recording-cli download <id> --stdout | ffmpeg -i - -ar 16000 -ac 1 out.wav
```

Each `data.pulled[]` item of `pull --json` includes `id`, `title`, `type`, `recordedAt` (ms), `duration` (s), `size`, `sha1`, `contactName`, `appName`, `file` (absolute path) and `relativePath`.

## Configuration and data

- **Project config**: `<cwd>/.mi-recording-cli/config.json` (`config set`): `output` (default `.mi-recording-cli/output/`), `fileNameTemplate` (default `${title}`), `concurrency` (default 3).
- **Pull state**: `<pull folder>/.mi-recording-cli.state.json`. If removed, existing identical files are adopted again without re-downloading.
- **Session** (macOS): `~/Library/Caches/mi-recording-cli/` (`cookie` + `browser-data/`).

> `.mi-recording-cli/` may contain your recordings; add it to `.gitignore` inside a git repository.

## Limitations

- **Upload / rename / edit**: not available on the web either; recordings are uploaded by the phone.
- **Advanced Data Protection (end-to-end encryption)**: audio must be decrypted on a signed-in device, so downloads are not supported (with a clear error); listing, deleting and the trash still work.
- **Overseas accounts**: only i.mi.com (mainland China) is supported for now.
- **Duration** comes from the phone's metadata; the rare recordings without it are estimated from bitrate (`durationEstimated: true`).

## Tips for AI agents

1. Always pass `--json`.
2. In non-interactive mode a missing session fails immediately; a human must run `login` once, after which the session renews itself.
3. Destructive operations require `-y`; preview with `--dry-run` first.
4. Partial failures still return `ok: true` with items in `data.failed` (plus `data.deleteFailed` and `data.warnings` for `pull`) and exit code 2; total failures return `ok: false` and exit code 1.

## Development

```bash
pnpm install
pnpm build
pnpm test               # unit tests (offline)
pnpm test:integration   # real API tests (requires login; read-only)
MI_RECORDING_CLI_TEST_ID=<id> pnpm test:integration  # plus a reversible delete → restore round trip
```

API notes: [docs/api.md](./docs/api.md).

## License

MIT
