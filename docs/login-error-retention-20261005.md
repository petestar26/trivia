# Keep rejected sign-in errors visible

The cloud-browser report of sign-in refreshing had a reproducible frontend cause: credentialRequest invalidates the session before rejecting a failed login; AuthProvider remounted its entire child tree even for anonymous-to-anonymous invalidation. The old login component then received the rejection after it had unmounted, losing its visible error.

Keep the anonymous form mounted while preserving cache clearing, publication-generation invalidation and session identity reset. Real authenticated identity transitions still remount their private tree. Login errors now have alert semantics and login inputs advertise username/current-password autocomplete.

The new regression failed before the fix and passed afterward. All 58 auth-provider, session and API-client tests passed. No backend, schema, password, role or cookie-policy changes. Recent staging request logs contained both successful sign-ins and rejected 401 attempts; these do not establish which submitted credential was wrong or prove an automation block. A fresh cloud tab was signed out. User reports normal-browser sign-in works.
