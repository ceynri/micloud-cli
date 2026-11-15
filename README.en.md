English | [简体中文](./README.md)

# micloud

A command-line tool for Xiaomi Cloud (i.mi.com), built for AI agents and scripts. Log in once to work with:

- **Notes**: read and write as Markdown; export, or sync two-way with a local folder
- **Recordings**: incrementally pull recordings your phone syncs to the cloud, then clean up the cloud copies

```bash
npm install -g micloud-cli
micloud login                               # log in with your Xiaomi account in a browser; renewed automatically
micloud note sync -o ./notes --mode two-way # two-way sync notes with a local folder
micloud rec pull -o ./recordings            # pull new recordings to disk
```

> Requires Node.js >= 18 and Chrome (opened for login). Without Chrome, run `npx playwright install chromium`.

For AI agents:

```bash
npx -y skills add ceynri/micloud-cli --all
```

> ⚠️ Experimental: minor versions (`0.Y.z`) may contain breaking changes. Pin the minor version (e.g. `~0.5.0`) if you need stability.

## For AI agents and scripts

- **Use `--json`**: success prints `{"ok":true,"data":...}`, failure prints `{"ok":false,"error":"..."}`. Logs and progress go to stderr.
- **Exit codes**: `0` success; `2` partial failure (still `ok:true`, failed items listed in `data`); `1` failure.
- **Never hangs**: in non-interactive mode (`--json` or no terminal) it never opens a browser. If the login has expired it fails right away; the user runs `micloud login` once in a terminal.
- **Deletes need explicit confirmation**: in non-interactive mode, deleting requires `-y`, otherwise it errors. Preview with `--dry-run` first.

## Notes: `micloud note`

| Command | Description |
|---|---|
| `list` / `get <id>` / `search <keyword>` | List, view (as Markdown; `--raw` for the original format), search |
| `create` / `update <id>` | Write Markdown from `--content`, `--file`, or stdin |
| `delete <id>` / `move <id> <folder>` / `pin` / `unpin` | Delete (to trash by default), move, pin |
| `folders` / `folder create\|rename\|delete` | Manage folders |
| `upload-image <path>` | Upload an image and get a reference to embed in a note |
| `export -o <dir>` | One-way export to Markdown; never changes the cloud |
| `sync -o <dir> --mode <mode>` | Two-way sync; `--dry-run` to preview |

Sync modes: `cloud-first` (download only), `local-first` (upload only), `two-way` (automatic both ways), `manual` (default, asks for each change). Real conflicts (both sides changed, or deleted on one side and edited on the other) are skipped and reported in non-interactive mode; data is never deleted on a guess. Cloud deletions only move notes to the trash.

Supported Markdown: headings, lists, checkboxes, quotes, dividers, bold / italic / strikethrough, links, inline code, and images. Tables and code-block languages are not supported; try important notes on a small scale first.

## Recordings: `micloud rec`

`rec` is short for `recording`.

| Command | Description |
|---|---|
| `list` / `search` / `info <id>` / `stats` | List, search, details, statistics |
| `pull -o <dir>` | Incremental pull: already-pulled recordings are skipped, even if you moved the files away |
| `download <id...>` | Download by id; `--stdout` to pipe |
| `url <id>` / `play <id>` | Temporary direct link (no login needed, about 4 hours), play in a player |
| `delete` | Move to trash: by id, by filter, or `--pulled` (pulled and verified locally) |
| `trash` / `trash restore` / `trash purge` | Trash: list, restore, delete permanently |

Filters (for list / stats / pull / delete): `--type recorder,phonecall,fm,app`, `--since 7d`, `--until 2026-07-31`, `-q keyword`.

Pull to disk, hand off to transcription, then clean up the cloud:

```bash
micloud rec pull -o ./recordings --json | jq -r '.data.pulled[].file'      # paths of newly pulled files
micloud rec delete --pulled -o ./recordings --dry-run                       # preview the cleanup
micloud rec delete --pulled -o ./recordings -y                              # move to trash
```

- **Safe downloads**: each file is written to `.part` first and only kept once its size and SHA-1 match the cloud; interrupted runs resume; existing files with the same name are never overwritten.
- **Safe cleanup**: `--pulled` only deletes recordings whose cloud copy is unchanged and whose local file is still intact. Add `--allow-moved` if you have moved the files elsewhere.
- **Deletes reach your phone**: Xiaomi Cloud syncs deletions to signed-in devices, so the recording is deleted from the phone too. The trash keeps recordings for 30 to 180 days depending on membership.

File names default to the phone's recording names. Customize with `--template`, e.g. `'${YYYY}-${MM}-${DD}_${HH}${mm}[_${contact}]'`; see `micloud rec pull --help` for placeholders.

## Configuration

Project settings live in `.micloud/config.json` in the current directory, one section per service, all optional:

```json
{
  "note": { "output": "notes", "syncMode": "two-way", "fileNameTemplate": "${YYYY}-${MM}-${DD}[_${title}]" },
  "recording": { "output": "recordings", "fileNameTemplate": "${title}", "concurrency": 3 }
}
```

- `-o` on the command line overrides `output`. Without either, `.micloud/note/` and `.micloud/recording/` are used.
- Sync / pull state is kept inside the output folder (`.micloud-note.state.json`, `.micloud-recording.json`), so the folder can be moved as a whole.
- The login lives in the system cache directory (`~/Library/Caches/micloud/` on macOS); delete it and run `login` again if needed.
- The default output folders `.micloud/note/` and `.micloud/recording/` hold your notes and recordings; add them to `.gitignore` inside a git repository. `config.json` can be committed.

## Limitations

- Only mainland China accounts (i.mi.com).
- With Advanced Data Protection (end-to-end encryption) enabled, recordings cannot be downloaded (you get a clear error); listing and deleting still work.
- Special note types such as private notes and mind maps are exported on a best-effort basis and cannot be edited.
- Recordings cannot be uploaded or renamed (the web app can't either).

## Upgrading from mi-note-cli

Add `note` to your commands: `mi-note-cli sync` becomes `micloud note sync`. Your login, configuration, and sync folders carry over automatically, with no need to log in or sync from scratch. See [MIGRATION.md](./MIGRATION.md) (Chinese).

## Development

```bash
pnpm install
pnpm typecheck && pnpm test        # type check and unit tests (no network)
MICLOUD_INTEGRATION=1 pnpm test:integration   # integration tests against a real account (log in first)
```

API notes: [docs/recording-api.md](./docs/recording-api.md). Issues and suggestions are welcome in [issues](https://github.com/ceynri/micloud-cli/issues).

## License

[AGPL-3.0](./LICENSE)
