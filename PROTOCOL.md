# Private notes: how the encryption works

Goal: agents of a workspace can leave notes on a conversation for each other, and the server stores the notes but **cannot read them**.

## Who holds which key

- The agents of a workspace agree on a **team passphrase** outside the app (for example, an admin tells the team in person or in their password manager). The passphrase is never sent to the server.
- Each agent's browser turns the passphrase into a key:
  `key = PBKDF2-SHA256(passphrase, salt = "switchboard-notes:" + workspaceId, 200 000 rounds) → AES-256-GCM key`
  (`scaffold/web/src/notesCrypto.ts`). The key exists only in that browser tab's memory and is gone after a reload.
- The server holds **no key**.

## What the server stores (`notes` collection)

| Field | Meaning |
| --- | --- |
| `workspace`, `contact` | Which conversation the note belongs to (plain) |
| `author`, `authorName` | Who wrote it (plain, taken from the session, not from the browser) |
| `createdAt` | When (plain) |
| `iv` | 12 random bytes, new for every note (base64) |
| `ciphertext` | AES-GCM encryption of the note text, including the auth tag (base64) |

Reading a note: the browser downloads `ciphertext` and `iv` and decrypts them with its key. If the passphrase is wrong, AES-GCM decryption fails and the UI says "Can not decrypt".

## Three attacks this scheme does NOT stop

1. **A malicious or hacked server changes the JavaScript it serves.** The same server delivers the app, so it could ship code that sends the passphrase or the decrypted notes back to it. End-to-end encryption in a web app trusts whoever serves the code.
2. **Guessing a weak passphrase offline.** Someone who steals the database (or the server operator) has the ciphertext and knows the salt (the workspace id). PBKDF2 makes each guess slow, but a short or common passphrase can still be found.
3. **A removed agent keeps access.** There is no key rotation or per-user keys. An agent who leaves still knows the passphrase and can read every old and new note (if they can get the ciphertext). Changing the passphrase also makes old notes unreadable for everyone.

Also not protected: the metadata (who wrote a note, when, on which conversation) is plain text, and the server can delete notes or hide some of them from a user without anyone noticing.
