/** Convert the small HTML subset `messaging.send` accepts into chat markup. */

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const decodeQuotes = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Slack mrkdwn: *bold*, _italic_, `code`, ```pre```, <url|text>. */
export function htmlToSlack(html: string): string {
  // Slack uses the same &amp; &lt; &gt; escapes as HTML, so those stay encoded.
  return decodeQuotes(
    html
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, url: string, text: string) => `<${url}|${text.replace(/<[^>]+>/g, "")}>`)
      .replace(/<\/?(b|strong)>/gi, "*")
      .replace(/<\/?(i|em)>/gi, "_")
      .replace(/<\/?pre>/gi, "```")
      .replace(/<\/?code>/gi, "`")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(?!(https?:|mailto:)[^>]*\|)[^>]+>/gi, ""),
  );
}

/** Slack needs &, < and > escaped in plain text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Discord markdown: **bold**, *italic*, `code`, ```pre```, [text](url). */
export function htmlToDiscord(html: string): string {
  return decode(
    html
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, url: string, text: string) => `[${text.replace(/<[^>]+>/g, "")}](${url})`)
      .replace(/<\/?(b|strong)>/gi, "**")
      .replace(/<\/?(i|em)>/gi, "*")
      .replace(/<\/?pre>/gi, "```")
      .replace(/<\/?code>/gi, "`")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}
