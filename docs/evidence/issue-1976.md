# Issue #1976 visual evidence

The screenshots below show the same file in the full-width existing diff dialog
at a 1440 px desktop viewport. They were captured with Playwright MCP after
opening the file from the compact file list and switching between the Unified
and Split controls in the dialog header. In Split view, the old and new panes
remain equal width and long lines stay within their own scrollable pane.

## Unified

![full-width-dialog-unified.png](/attachments/90f3fb8acd631694809ed50a61a13519527ba7e976449cc4933451b52de910c4)

## Split

![full-width-dialog-split.png](/attachments/f0e764b0307ec384fc2c80b37269c568dab7ce6177391ee8ac69c28a15c03654)
