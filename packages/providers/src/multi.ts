import type { MessagingProvider, MessagingSendOptions } from "@actuate/sdk";

/** The `channel` name a messaging provider answers to: its kind, except Resend, which is "email". */
export function channelName(kind: string): string {
  return kind === "resend" ? "email" : kind;
}

/**
 * One `ctx.messaging` over the configured providers. `send(..., { channel })` picks one by
 * channel name ("telegram", "whatsapp", "slack", "discord", "custom-webhook", "email") or kind ("resend"); without
 * `channel`, the first (the default) sends. A channel that isn't configured is refused, even when only one
 * provider is: a recipient meant for one channel is never sent through another.
 */
export function combineMessaging(entries: Array<{ kind: string; provider: MessagingProvider }>): MessagingProvider {
  if (entries.length === 0) throw new Error("combineMessaging needs at least one provider");
  return {
    send(to: string, text: string, options?: MessagingSendOptions) {
      const wanted = options?.channel?.trim().toLowerCase();
      const entry = wanted ? entries.find((e) => e.kind === wanted || channelName(e.kind) === wanted) : entries[0];
      if (!entry) {
        const names = entries.map((e) => channelName(e.kind)).join(", ");
        return Promise.reject(new Error(`No "${options!.channel}" messaging channel is configured. Configured: ${names}.`));
      }
      return entry.provider.send(to, text, options);
    },
  };
}
