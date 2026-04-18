# NEET Scan Deployment Instructions

## Hosting on Vercel

1. **Connect your Repo**: Push your code to GitHub/GitLab/Bitbucket and connect it to Vercel.
2. **Framework Preset**: Vercel will automatically detect **Vite**.
3. **Build Command**: `npm run build`
4. **Output Directory**: `dist`
5. **Environment Variables**:
   - Go to Project Settings > Environment Variables.
   - Add `GEMINI_API_KEY`: Your Google AI Studio API key.

## Mobile Compatibility

- This app uses **Tailwind CSS** with a mobile-first approach.
- The exam interface includes a retractable sidebar (`Question Map`) for smaller screens.
- All interactive components (buttons, tabs, matching tables) are optimized for touch interactions (min-height 44px).
- Local storage is handled via **IndexedDB** for reliability on mobile browsers.

## Firebase Authentication (Google Login)
If you see an "unauthorized domain" error during login on Vercel:
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Select your project.
3. Go to **Authentication** > **Settings** > **Authorized Domains**.
4. Add `neet-pearl.vercel.app` to the list.
5. Save changes.
