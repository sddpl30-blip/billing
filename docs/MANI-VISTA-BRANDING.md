# Mani Vista Residents Association — frontend rebrand

The supplied association logo is stored **unchanged** at `public/branding/mani-vista-logo.png`.

## Deliverables
- New emerald-green / metallic-gold / ivory visual palette throughout existing React screens.
- Mani Vista logotype and logo in sign-in, desktop sidebar, mobile header, receipts and browser icon.
- Two selectable visual options: **Emerald & Gold** and **Ivory & Gold**. The selector is visible on the login screen and desktop/mobile layouts. The setting is only a visual preference; it is not financial data.
- Updated document title, app description and old demonstration society front-end labels.
- Removed Pune/Maharashtra-specific presentation copy; these must not be treated as Mani Vista legal compliance statements.

## Technical caveats
- Backend and database schema, auth logic, accounting calculations and API paths were not modified.
- Real society master data, legal registrations and actual billing documents must be configured in the backend and reviewed before live use. Changing a UI label does not change authoritative records.
- All 73 accounting, 59 integration and 34 persistence tests passed after changes; TypeScript stub typecheck passed using the compatible module resolver. Frontend Vite visual build was not run because frontend npm dependencies are not installed in this environment.
- First-party client image is 1248x1248; it was copied without modification as requested.

## Customize colours
Edit `src/index.css` variables beginning with `--mv-`. Appearance is controlled by `document.documentElement.dataset.mvTheme` and selector component `src/components/ThemeSwitcher.tsx`.
