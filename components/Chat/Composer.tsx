"use client";

import {
  type FormEvent,
  type KeyboardEvent,
  useMemo,
  useState,
} from "react";

type ComposerProps = {
  disabled: boolean;
  cooldownSeconds: number;
  maxChars: number;
  helperText?: string | null;
  onSend: (text: string) => Promise<void>;
};

export default function Composer({
  disabled,
  cooldownSeconds,
  maxChars,
  helperText,
  onSend,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);

  const normalized = useMemo(() => draft.replace(/\s+/g, " ").trim(), [draft]);
  const overLimit = normalized.length > maxChars;
  const sendDisabled =
    disabled || isSending || overLimit || !normalized || cooldownSeconds > 0;

  const statusText =
    cooldownSeconds > 0
      ? `Send available in ${cooldownSeconds}s`
      : helperText ?? `${normalized.length}/${maxChars}`;

  async function submit() {
    if (sendDisabled) {
      return;
    }

    setIsSending(true);
    try {
      await onSend(draft);
      setDraft("");
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        className="composer-input"
        maxLength={maxChars + 40}
        placeholder="Speak to the room..."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || isSending}
      />
      <div className="composer-row">
        <p className="composer-meta">{statusText}</p>
        <button className="composer-send" type="submit" disabled={sendDisabled}>
          Send
        </button>
      </div>
    </form>
  );
}
