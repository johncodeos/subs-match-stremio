# Greek Sub Match for Stremio

Greek Sub Match compares subtitle release names with the streams for the same movie or episode. It ranks saved confirmations and video hash matches ahead of exact filenames and likely release matches. It understands shared releases such as `1080/720p YTS.AG` and keeps each source, resolution, and group together when a listing names separate versions.

## Start and configure on a Mac

1. Double-click `Start.command` and leave its Terminal window open. It uses Node.js 22 or later and can use the copy bundled with ChatGPT on this Mac.
2. Open `http://127.0.0.1:7331/configure`. You can also double-click `Configure.command`.
3. Add the install link for a Stremio add-on that supplies playable movie or series streams. Find it through **Addons → Installed → Share addon** or its own setup page. The link looks like `https://example.com/manifest.json`. You can add a second source in the optional field.
4. Enter a key for at least one subtitle provider, choose your preferences, and set a configuration password. Select **Save settings**. [SubDL API](https://subdl.com/api-doc) · [OpenSubtitles API Consumers](https://www.opensubtitles.com/en/consumers) · [SubSource API](https://subsource.net/api-docs)
5. Choose **Install in Stremio**, or use **Copy install link** and paste it into **Stremio Web → Addons → Add addon**. Use that private install entry’s **Configure** button to unlock and edit your saved settings. Existing local installations can still open the loopback manifest at `http://127.0.0.1:7331/manifest.json`.

Use the Stremio Web site’s Chrome **Apps on device** permission if the site cannot reach a local add-on. After saving changes, refresh the movie or episode to see updated stream results. The install link stays the same when you edit settings or change the configuration password.

Saved stream links appear in multiline boxes, one link per box. Use each API key’s eye button to reveal or hide its value. The server writes settings to `.settings.json` with owner-only permissions. The installation password is stored as a salted hash. If you forget it, open the host’s loopback Configure page to set a new one.

## Private VPS deployment

Run one instance per owner. Use the private install link to grant Stremio access to the instance, and unlock its Configure page with the password you choose. Keep the initial setup and password recovery available through SSH.

1. On the VPS, install Node.js 22 or later, `unzip`, and [Caddy](https://caddyserver.com/docs/install). Point a hostname such as `addon.example.com` to the VPS. Run the app as an unprivileged user in a persistent directory. Keep port `7331` bound to loopback and open ports `80` and `443` for Caddy.
2. For a fresh install, copy `.env.example` to `.env` and limit permissions with `chmod 600 .env`. Set the hostname used for the private install URL:

   ```dotenv
   HOST=127.0.0.1
   PORT=7331
   PUBLIC_URL=https://addon.example.com
   ```

3. Configure Caddy to forward private installation routes over HTTPS. The server checks the generated install token and requires a password for editing settings. The root Configure page remains on loopback. [Caddy HTTPS setup](https://caddyserver.com/docs/automatic-https)

   ```caddyfile
   addon.example.com {
       @stremio {
           method GET POST OPTIONS
           path_regexp ^/install/[a-f0-9]{64}/(manifest[.]json|addon-icon[.]png|stream/(movie|series)/[A-Za-z0-9:]+[.]json|track/[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.]vtt|configure(/(check|reveal|logout|fields[.]js))?)$
       }
       handle @stremio {
           reverse_proxy 127.0.0.1:7331
       }
       handle {
           respond 404
       }
   }
   ```

4. Start the app from the project folder with `node --env-file=.env src/server.js` and keep it running with your service manager. From your computer, open an SSH tunnel and visit `http://127.0.0.1:7332/configure`. Save the stream links, subtitle keys, preferences, and configuration password. [OpenSSH port forwarding](https://man.openbsd.org/ssh.1)

   ```sh
   ssh -N -L 127.0.0.1:7332:127.0.0.1:7331 your-user@addon.example.com
   ```

5. Use the **Install in Stremio** or **Copy install link** button on Configure. Check that the generated HTTPS manifest loads. Verify that the bare public `/manifest.json` and `/configure` return `404`, and the installed add-on’s **Configure** button opens the password prompt.

The generated install URL contains a random access token and grants access to the streams returned by your configured providers. Keep it out of public posts, GitHub, and shared logs. Keep `.env`, `.settings.json`, and `.confirmations.json` on the VPS and in private backups. Review the staged files before publishing the repository. [GitHub ignored files](https://docs.github.com/en/get-started/git-basics/ignoring-files)

## Shared Configure page

To let other people install from one hosted site, deploy the VPS setup above with `PUBLIC_SIGNUP=1` in `.env`. On the public hostname, `/configure` opens a blank form. Each visitor enters their own stream add-on links and subtitle API keys, sets a password, and selects **Create install link**. They can install from the generated link and use **Configure** in Stremio to unlock their own settings. The host administrator can still use the loopback address through the SSH tunnel.

Add this matcher to the same Caddy site, alongside the private installation matcher. Keep the fallback `404` handler.

```caddyfile
@signup {
    method GET POST
    path / /configure /configure/fields.js /addon-icon.png
}
handle @signup {
    reverse_proxy 127.0.0.1:7331
}
```

Users of the shared page need stream add-on manifest URLs on public HTTPS hostnames. Local addresses, the Greek Sub Match hostname, and redirects from stream endpoints are excluded. The server validates and pins the public DNS address before connecting to each user-supplied stream source. Use VPS network rules to restrict outbound access to private infrastructure as an additional layer. [OWASP guidance on server-side requests](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

Keep `.installations/` in private, persistent storage along with your other settings. It contains separate provider keys, salted password hashes, and timing confirmations for each installation. This mode is designed for one running Node process per data directory. It currently supports up to 200 installations and limits signup and stream request rates. Keep private install URLs out of proxy access logs.

## Shortlist and timing

The default **Greek shortlist** shows up to 12 matches and collapses identical playback URLs. If no Greek release matches, the shortlist shows a message that opens the title check. Choose **All streams, Greek matches first** in Configure to include the rest in the same list. Use **Exact and likely match label position** to place those labels at the start, after the first line, or at the end of stream details.

Open **Check a movie or episode** in Configure and paste a Stremio detail link, IMDb ID, or TMDB ID. The page shows the number of streams, the status of each configured subtitle provider, and the release details behind its best matches. After checking the timing in playback, find the same row by the short File ID shown in the Greek subtitle label and press **Timing is good**. Enter an optional delay in seconds. A positive number shows subtitles later. Use **Remove confirmation** to undo it.

Confirmed timings are saved locally in `.confirmations.json`. They apply to the identified playback file. The add-on uses a video hash, file name plus byte size, or exact playback source, depending on the metadata the source provides.

## Provider behavior

OpenSubtitles uses its REST API and the anonymous download quota. The separately installed OpenSubtitles v3 add-on does not provide this matcher with an API key. If first-pass results yield no match, OpenSubtitles checks a second results page when available, or searches by a representative release filename. SubDL also tries the filename. OpenSubtitles hash lookups use hashes supplied by the stream add-on. The add-on serves SRT as UTF-8 WebVTT, including compatible files in SubDL and SubSource ZIP packs. SubSource searches by IMDb ID and uses Greek release names to match movies and episodes.

The matcher supports IMDb and TMDB IDs, including AIOMetadata episode IDs such as `tmdb:123456:2:3`. If your source doesn’t return streams for a title’s ID, try its Cinemeta listing. Release metadata estimates timing compatibility. If a subtitle provider is unavailable, the other configured providers can still supply matches.

## Checks

Run `node --test` from this folder using Node.js 22 or later. Tests exercise local settings, stream ranking, ZIP episode selection, and simulated subtitle API search and downloads.
