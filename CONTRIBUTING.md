# Working in this repository

## First time

    git clone https://github.com/Dhruvachaitanya13/halo.git
    cd halo

## Every change

1. Get the latest code: `git checkout main && git pull`
2. Make a branch named after you and the change: `git checkout -b kavya/radiation-model`
3. Commit small and often, with a message that says what changed.
4. Push and open a pull request: `git push -u origin HEAD`, then open the link GitHub prints.
5. One teammate looks at it and merges. If it only touches your own folder and the tests pass, merge it yourself. We have two days.

Anything merged into `main` goes live on the GitHub Pages site within a minute or two, so do not merge a broken `scan/`.

## Who owns what

| Folder | Owners |
|---|---|
| `scan/` | Dhruva, Prathiksha, Chris |
| `scan/style.css`, page layout | Anusha, Shreyas |
| `data/`, model training (add a `model/` folder) | Kavya, Chris |
| `twilio/`, agent (add an `agent/` folder) | Dhruva, Prathiksha |
| dashboard and project page (add `dashboard/`, `site/`) | Anusha, Shreyas, Prathiksha |

## Rules

- Never commit secrets: Twilio tokens, Supabase service keys, API keys. Put them in a `.env` file, which git ignores. The Supabase anon key is the one exception; it is meant to be public.
- Run `npm test` in `scan/` before pushing changes to `scan/js/dsp.js`.
- Do not add data that is not from NASA to `data/`. Every new column needs a row in `data/SOURCES.md`.
- Label anything simulated as simulated, on screen and in the code.
