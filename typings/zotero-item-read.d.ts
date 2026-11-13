/**
 * Local augmentations of zotero-types for APIs present in the installed
 * Zotero (10.x) but missing from the published typings.
 */

declare namespace Zotero {
  interface Item {
    /**
     * Last time this attachment was opened in the reader, as an integer
     * Unix timestamp in seconds, or null when never read. Only set for
     * attachment items in My Library and groups.
     */
    attachmentLastRead: number | null;
    /**
     * Last-read time for any item: attachmentLastRead for attachments,
     * the newest attachmentLastRead among child attachments otherwise.
     * Returns null when never read. (Zotero "Last Read" column.)
     */
    getItemLastRead(): number | null;
  }
}
