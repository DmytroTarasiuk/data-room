import { FormEvent, useEffect, useMemo, useState } from "react";
import { Copy, Link2, Mail, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, ResourceType, Share, request } from "../lib/api";
import { formatDate } from "../lib/format";
import { Button, IconButton, Modal, Notice, Spinner, TextInput } from "./ui";

type Props = {
  resourceType: ResourceType;
  resourceId: string;
  label: string;
  onClose: () => void;
};

export function ShareDialog({ resourceType, resourceId, label, onClose }: Props) {
  const [mode, setMode] = useState<"PUBLIC" | "PERMISSIONED">("PUBLIC");
  const [email, setEmail] = useState("");
  const [shares, setShares] = useState<Share[]>([]);
  const [created, setCreated] = useState<Share | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const activeShares = useMemo(() => shares.filter((share) => !share.revokedAt), [shares]);

  async function loadShares() {
    setLoading(true);
    setError("");
    try {
      const payload = await request<{ shares: Share[] }>(
        `/api/shares?resourceType=${resourceType}&resourceId=${resourceId}`
      );
      setShares(payload.shares);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load shares");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadShares();
  }, [resourceId, resourceType]);

  function shareLink(token: string) {
    return `${window.location.origin}/share/${token}`;
  }

  async function copy(token: string) {
    const link = shareLink(token);
    try {
      await navigator.clipboard.writeText(link);
      setMessage("Link copied");
    } catch {
      setMessage(link);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload = await request<{ share: Share }>("/api/shares", {
        method: "POST",
        body: {
          resourceType,
          resourceId,
          mode,
          role: "VIEWER",
          recipientEmail: mode === "PERMISSIONED" ? email : undefined
        }
      });
      setCreated(payload.share);
      setMessage(mode === "PUBLIC" ? "Public viewer link is ready" : "Permissioned viewer link is ready");
      await loadShares();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create share");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(share: Share) {
    setError("");
    setMessage("");
    try {
      await request(`/api/shares/${share.id}`, { method: "DELETE" });
      setMessage("Access revoked");
      await loadShares();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke access");
    }
  }

  return (
    <Modal title={`Share ${label}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}

        <div className="grid grid-cols-2 gap-2 rounded-md bg-[#eef2f0] p-1">
          <button
            type="button"
            onClick={() => setMode("PUBLIC")}
            className={`flex h-10 items-center justify-center gap-2 rounded text-sm font-medium ${
              mode === "PUBLIC" ? "bg-white text-[#1f2a2d] shadow-sm" : "text-[#667478]"
            }`}
          >
            <Link2 size={16} />
            Public link
          </button>
          <button
            type="button"
            onClick={() => setMode("PERMISSIONED")}
            className={`flex h-10 items-center justify-center gap-2 rounded text-sm font-medium ${
              mode === "PERMISSIONED" ? "bg-white text-[#1f2a2d] shadow-sm" : "text-[#667478]"
            }`}
          >
            <Mail size={16} />
            Specific email
          </button>
        </div>

        {mode === "PERMISSIONED" ? (
          <label className="block text-sm font-medium text-[#334044]">
            Recipient email
            <TextInput
              className="mt-1.5"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="reviewer@company.com"
              required
            />
          </label>
        ) : null}

        <Button disabled={saving} className="w-full">
          {saving ? <Spinner /> : null}
          Create viewer link
        </Button>
      </form>

      {created ? (
        <div className="mt-4 rounded-md border border-[#d7ddda] bg-[#f7f9f8] p-3">
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="h-9 min-w-0 flex-1 rounded border border-[#d4dad7] bg-white px-2 text-xs text-[#4c5a5d]"
              value={shareLink(created.token)}
            />
            <IconButton title="Copy link" onClick={() => copy(created.token)}>
              <Copy size={17} />
            </IconButton>
          </div>
        </div>
      ) : null}

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#2c383b]">Active access</h3>
          <IconButton title="Refresh shares" onClick={loadShares}>
            <RefreshCw size={16} />
          </IconButton>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-[#667478]">
            <Spinner />
            Loading
          </div>
        ) : activeShares.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#d2d9d6] p-4 text-sm text-[#667478]">
            No active shares.
          </p>
        ) : (
          <div className="max-h-52 space-y-2 overflow-auto thin-scrollbar">
            {activeShares.map((share) => (
              <div
                key={share.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[#e1e6e4] bg-white p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#253033]">
                    {share.mode === "PUBLIC" ? "Anyone with link" : share.recipientEmail}
                  </p>
                  <p className="mt-0.5 text-xs text-[#738083]">{formatDate(share.createdAt)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton title="Copy link" onClick={() => copy(share.token)}>
                    <Copy size={16} />
                  </IconButton>
                  <IconButton title="Revoke access" onClick={() => revoke(share)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
