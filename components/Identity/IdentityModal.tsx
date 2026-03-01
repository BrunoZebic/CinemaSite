"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  createIdentity,
  isValidNickname,
  normalizeNickname,
  type Identity,
} from "@/lib/identity";

type IdentityModalProps = {
  open: boolean;
  onSave: (identity: Identity) => void;
};

export default function IdentityModal({ open, onSave }: IdentityModalProps) {
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeNickname(nickname);

    if (!isValidNickname(normalized)) {
      setError("Use 2-20 characters: letters, numbers, spaces, - or _.");
      return;
    }

    setError(null);
    onSave(createIdentity(normalized));
  }

  return (
    <>
      <div className="identity-backdrop" />
      <div className="identity-modal">
        <div className="identity-card slide-in">
          <h2 className="identity-title">Choose your premiere identity</h2>
          <p className="identity-copy">
            Name first, then speak.
            <br />
            No emails. No tracking. Just cinema together.
          </p>
          <form onSubmit={handleSubmit}>
            <label className="identity-field">
              <span className="identity-label">Nickname</span>
              <input
                data-testid="identity-nickname-input"
                className="identity-input"
                ref={inputRef}
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="ex: MidnightFox"
                maxLength={20}
                autoComplete="off"
              />
            </label>
            {error ? <p className="identity-error">{error}</p> : null}
            <button
              data-testid="identity-submit"
              className="identity-submit"
              type="submit"
            >
              Enter Premiere
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
