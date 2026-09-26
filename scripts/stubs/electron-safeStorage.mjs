/**
 * Stand-in for the `electron` module so the `ss1` codec can be exercised
 * outside Electron. Deliberately a *stub* of the native module, not of the
 * vault: everything between `require('electron')` and the file on disk is the
 * real implementation, including the change detection and the migration.
 *
 * The transform is reversible and obvious on purpose — a fake cipher we can
 * read at a glance is the difference between "the value is encrypted" and
 * "the value is obfuscated", and this file has to be readable as the former.
 */
const PREFIX = 'FAKE1:'

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(PREFIX + plainText, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith(PREFIX)) throw new Error('not encrypted by safeStorage')
    return text.slice(PREFIX.length)
  }
}
