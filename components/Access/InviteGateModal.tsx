"use client";

import { FormEvent, useState } from "react";

type InviteGateModalProps = {
  open: boolean;
  room: string;
  onSuccess: () => Promise<void> | void;
};

export default function InviteGateModal({
  open,
  room,
  onSuccess,
}: InviteGateModalProps) {
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteCode.trim()) {
      setError("Enter an invite code.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${room}/access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteCode: inviteCode.trim(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? "Invite validation failed.");
        return;
      }

      await onSuccess();
      setInviteCode("");
    } catch {
      setError("Network error while validating invite.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="identity-backdrop" />
      <div className="identity-modal">
        <div className="identity-card slide-in">
          <h2 className="identity-title">Room Access Required</h2>
          <p className="identity-copy">
            This screening is invite-only.
            <br />
            Enter your access code to continue.
          </p>
          <form onSubmit={handleSubmit}>
            <label className="identity-field">
              <span className="identity-label">Invite Code</span>
              <input
                data-testid="invite-code-input"
                className="identity-input"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                autoComplete="off"
                disabled={submitting}
              />
            </label>
            {error ? <p className="identity-error">{error}</p> : null}
            <button
              data-testid="invite-submit"
              className="identity-submit"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Validating..." : "Enter Room"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
