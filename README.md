# Staple Sorter

A small web app for filing a Yu-Gi-Oh! staples collection by **why you pull a card**:

- **Categories** you define (Handtraps, Board Breakers, Engines…). Their order is your filing priority and your box order.
- **Packages**: cards that always travel together (Exodia + limbs, Psy-Frame Driver + Framegears). A package sits in one category, sorts alphabetically by its name, and keeps its cards in the order you choose. The first card is the lead.
- **Type sections** for everything else: Main Deck Monsters, Spells, Traps, Fusion, Synchro (by level), Xyz (by rank), Link (by rating). These come after your categories.
- One entry per card, no counts. Alt-art passcodes always collapse to the card's primary passcode and art.

Card names and types come from the free YGOPRODeck API, downloaded once and cached in your browser. The app only re-downloads when YGOPRODeck reports a new database version (checked at most once a day). Thumbnails come from your FavoriteYGO GitHub Pages image host.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js`, `logic.js` | The app |
| `config.js` | Your Supabase URL/key and the image host. **The only file you edit.** |
| `schema.sql` | One-time database setup for Supabase |

## Setup (about 10 minutes)

### 1. Create the Supabase project
1. Sign in at supabase.com and create a new project (free plan).
2. Open **SQL Editor → New query**, paste all of `schema.sql`, and click **Run**.

### 2. Create your login
1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter your email and a password, and tick **Auto Confirm User**.
3. Optional but recommended: under **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**, so nobody else can create an account on your project.

### 3. Connect the app
1. Go to **Project Settings → API Keys** and copy the project URL and the **publishable** key (older projects call it the **anon** key).
2. Paste both into `config.js`.

The publishable key is designed to be public. Your data is protected by the row-level security rules in `schema.sql` and by your login. **Never** put the `service_role` / secret key in `config.js`.

### 4. Host it on GitHub Pages
1. Create a repo (or a folder in an existing Pages repo) and commit all the files.
2. In the repo: **Settings → Pages → Deploy from a branch**, then pick the branch and folder.
3. Open the Pages URL and sign in.

To try it locally first, run `python3 -m http.server` in this folder and open http://localhost:8000. Opening `index.html` directly from disk won't work, because browsers block ES modules on `file://`.

## Using it

- **Search** (press `/` to jump to it) by name or passcode, alt-art passcodes included. Each result shows where that card is filed. Owned cards are listed first.
- **Click a card** to add it, move it, or remove it. You can also put it in a package or start a new package from it.
- **Collection** shows your whole collection in physical filing order. Slot numbers count cards within each section. **Grid** shows thumbnails; **List** is better for scanning or for working through boxes. Use **Jump to section** to skip ahead.
- **Categories**: add, rename, and reorder categories, and create packages. A package created under *Type sections* (like Exodia) files under its lead card's type section.
- **Packages**: rename, change category, reorder cards, set the lead (★), add cards by search, or take cards out.
- **Import**: paste a `.ydk` or open the file. Pick which parts to include (Main, Extra, Side) and where the cards should go. The preview shows:
  - cards that will be added
  - cards already filed elsewhere. Cards that had no category are pre-checked to move; cards already in a category or package are not, so an import never silently re-files something you placed deliberately.
  - cards already in that location, which are skipped
  - passcodes the card database doesn't recognize
  
  Use **None** as the category to simply mark a deck's cards as owned without filing them.

## Things to know

- **Free Supabase projects pause after a week without use.** Your data is kept. If the app says it can't reach the server, open the Supabase dashboard and click **Restore project**, wait a minute, then reload.
- **Deleting a category** keeps its cards; they go back to their type sections, and its packages move to the type sections intact. **Deleting a package** keeps its cards loose in that package's category.
- **Missing images** show as a colored tile with the card's name, colored by frame type: orange for effect, green for spell, pink for trap, and so on.
- **Card data**: if a new set is out and a card doesn't show up yet, use **Categories → Card data → Re-download card data**.
