# Install FinWise as an Android web app

FinWise includes a web app manifest, 192 px and 512 px icons, standalone display mode, and a service worker with an offline notice. The service worker only handles page navigation and caches the offline notice. It never caches API responses, account data, transactions, or the signed-in app page.

## Use a private HTTPS address

Android Chrome needs a secure origin for the full PWA experience. `http://192.168.x.x:3000` and `http://100.x.y.z:3000` are private addresses, but they are still HTTP and do not count as secure origins. A home-screen shortcut from either address can open as a browser tab. `http://localhost` is a development exception on the device running the browser; it does not refer to your NAS from an Android phone.

Chrome's [PWA debugging guidance](https://web.dev/learn/pwa/tools-and-debug) specifically notes that substituting a local IP for localhost does not meet the HTTPS requirement.

If **Tailscale runs on the TrueNAS host**, its private Serve feature can provide a certificate and HTTPS hostname without exposing FinWise to the public internet. After deploying this FinWise version, run on that host:

```sh
tailscale serve --bg 3000
tailscale serve status
```

Use the `https://<nas-name>.<tailnet>.ts.net/` address printed by `tailscale serve status` on the Android device while connected to the same tailnet. If Tailscale is only on a separate subnet router or in an isolated container, configure a trusted HTTPS reverse proxy reachable through your LAN or private VPN instead. **Do not use Tailscale Funnel**: it publishes the app to the internet, including any enabled unauthenticated quick-expense and widget routes.

See [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) for its private HTTPS behavior and setup prerequisites.

If you use only HTTPS for the signed-in app, set `FINWISE_ALLOW_INSECURE_HTTP=false` in the NAS `.env` and recreate the Compose service. See [deployment instructions](../deploy/README.md). Keep the same HTTPS hostname on Wi-Fi and VPN when possible; Chrome treats different hostnames and ports as different apps.

## Install in Chrome

1. On Android, open the **Chrome** app and visit the private HTTPS FinWise URL. Sign in and confirm the page loads.
2. Open Chrome's **⋮** menu and choose **Install and create shortcut → Install** (some Chrome versions show **Install app**).
3. Launch FinWise from its new icon. It should open without Chrome's address bar.

Google documents the current menu under [Use web apps on Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en).

After updating an older NAS deployment, reload the HTTPS page in Chrome. If you previously added an HTTP shortcut, remove it and install again from the HTTPS URL. If Chrome offers only **Create shortcut**, check that the address starts with `https://`, the certificate is trusted, and `https://<your-host>/manifest.webmanifest` and both icon URLs load. The app does not install automatically after a normal browser visit.

An offline launch displays a reconnect notice. FinWise requires the NAS connection to view or change financial data.
