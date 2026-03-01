"use client";

import { FormEvent, useState } from "react";

type HostAuthInlineProps = {
  room: string;
  isHost: boolean;
  onSuccess: () => Promise<void> | void;
};

export default function HostAuthInline({
  room,
  isHost,
  onSuccess,
}: HostAuthInlineProps) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (isHost) {
    return <p className="premiere-time">Host controls enabled</p>;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passphrase.trim()) {
      setError("Enter host passphrase.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${room}/host-auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ passphrase: passphrase.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? "Host auth failed.");
        return;
      }
      await onSuccess();
      setOpen(false);
      setPassphrase("");
    } catch {
      setError("Network error during host auth.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="host-auth-box">
      <button
        className="message-action"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Cancel Host Unlock" : "Unlock Host Controls"}
      </button>
      {open ? (
        <form className="host-auth-form" onSubmit={handleSubmit}>
          <input
            className="identity-input"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="Host passphrase"
            disabled={submitting}
          />
          {error ? <p className="identity-error">{error}</p> : null}
          <button className="identity-submit" type="submit" disabled={submitting}>
            {submitting ? "Checking..." : "Enable"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
