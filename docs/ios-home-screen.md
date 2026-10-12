# FinWise on the iPhone Home Screen

FinWise can open as a standalone Home Screen web app. Deploy the current web files on the NAS first; its page now includes an app manifest, an iPhone icon, and standalone display metadata. Installation happens on each iPhone.

1. Connect the iPhone to the same trusted Wi-Fi as the NAS, or to its private VPN.
2. In **Safari**, open `http://YOUR_NAS_IP:3000/` on Wi-Fi. Use the NAS's private VPN address when remote. Replace `YOUR_NAS_IP` with the NAS address; `127.0.0.1` on an iPhone points to the iPhone itself.
3. Tap Safari's **Share** button, then **Add to Home Screen**. If that action is missing, scroll to **Edit Actions** and add it.
4. Turn on **Open as Web App**, then tap **Add**. Launch FinWise from the new Home Screen icon.

If an older Home Screen icon still opens a Safari tab, remove that icon and add FinWise again after deploying the updated web files. Check that **Open as Web App** is on while adding it. The Home Screen icon does not appear automatically merely by visiting the site.

Use a trusted HTTPS reverse proxy with a valid certificate if available. On a trusted LAN where you intentionally use HTTP, the NAS deployment must allow its HTTP cookie setting as described in [deployment instructions](../deploy/README.md). Keep the unauthenticated quick-entry and widget endpoints off public proxies and tunnels.
