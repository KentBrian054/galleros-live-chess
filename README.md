# Galleros Live Chess

Features included:
- Play vs Computer: Easy / Medium / Hard
- White or Black side
- Legal chess moves, check/checkmate/draw detection
- Move history
- Flip board, undo, resign, restart
- Mobile responsive UI
- Supabase schema for live rooms and move history

## Live mode setup
1. Create a dedicated Supabase project.
2. Enable Anonymous Sign-Ins in Supabase Auth.
3. Run `database.sql`.
4. Add Supabase JS client and connect the live-room actions in `app.js` using a publishable key only.
5. Never expose a service_role key in frontend code.

- Game Analysis: Best / Good / Inaccuracy / Mistake / Blunder labels, plus a suggested better move for errors.

- Members directory with total verified-member count, search, website rank, rating, games, and W-D-L.


Authentication update: Google OAuth is now the primary login method. Enable the Google provider in Supabase Auth and add the Netlify production URL to the Supabase redirect allow list.

## GitHub Pages deployment

This is a static app and can be deployed from a GitHub repository named `galleros-live-chess`.

1. Push the project to GitHub with the default branch named `main`.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy-pages.yml` deploys the site after every push to `main`.
4. Add the resulting `https://<account>.github.io/galleros-live-chess/` URL to the Supabase Auth redirect allow list.

The browser only uses the Supabase publishable key in `config.js`. Never add a Supabase `service_role` key to this repository.
