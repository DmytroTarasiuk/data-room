import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Database,
  FileText,
  FolderOpen,
  LogOut,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck
} from "lucide-react";
import {
  ApiError,
  DataRoom,
  ShareResolveResponse,
  SharedItem,
  User,
  fileContentUrl,
  request
} from "./lib/api";
import { formatBytes, formatDate, pluralize } from "./lib/format";
import { AuthView } from "./components/AuthView";
import { DataRoomBrowser } from "./components/DataRoomBrowser";
import { Button, EmptyState, IconButton, Modal, Notice, Spinner, TextInput } from "./components/ui";

type Route =
  | { kind: "home" }
  | { kind: "room"; roomId: string; folderId: string }
  | { kind: "share"; token: string };

type RoomsPayload = {
  owned: DataRoom[];
  shared: SharedItem[];
};

function parseRoute(): Route {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "share" && parts[1]) {
    return { kind: "share", token: parts[1] };
  }
  if (parts[0] === "rooms" && parts[1] && parts[2] === "folders" && parts[3]) {
    return { kind: "room", roomId: parts[1], folderId: parts[3] };
  }
  return { kind: "home" };
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    request<{ user: User | null }>("/api/auth/me")
      .then((payload) => setUser(payload.user))
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[#667478]">
        <Spinner />
        <span className="ml-2">Opening workspace</span>
      </main>
    );
  }

  if (route.kind === "share") {
    return <ShareView token={route.token} user={user} onAuth={setUser} />;
  }

  if (!user) {
    return <AuthView onAuth={setUser} />;
  }

  return <Dashboard route={route} user={user} onUserChange={setUser} />;
}

function Dashboard({
  route,
  user,
  onUserChange
}: {
  route: Route;
  user: User;
  onUserChange: (user: User | null) => void;
}) {
  const [rooms, setRooms] = useState<RoomsPayload>({ owned: [], shared: [] });
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [roomName, setRoomName] = useState("Project Horizon Data Room");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const currentRoom = useMemo(
    () => (route.kind === "room" ? rooms.owned.find((room) => room.id === route.roomId) : undefined),
    [rooms.owned, route]
  );

  const totals = useMemo(
    () =>
      rooms.owned.reduce(
        (acc, room) => ({
          sizeBytes: acc.sizeBytes + room.sizeBytes,
          fileCount: acc.fileCount + room.fileCount,
          folderCount: acc.folderCount + room.folderCount
        }),
        { sizeBytes: 0, fileCount: 0, folderCount: 0 }
      ),
    [rooms.owned]
  );

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await request<RoomsPayload>("/api/data-rooms");
      setRooms(payload);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load data rooms");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!roomName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const payload = await request<{ room: DataRoom; conflictResolved: boolean }>("/api/data-rooms", {
        method: "POST",
        body: { name: roomName }
      });
      setCreateOpen(false);
      setRoomName("Project Horizon Data Room");
      await loadRooms();
      navigate(`/rooms/${payload.room.id}/folders/${payload.room.rootFolderId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create data room");
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await request("/api/auth/logout", { method: "POST" });
    onUserChange(null);
    navigate("/");
  }

  return (
    <main className="flex h-screen min-h-[680px] bg-[#f4f6f5] text-[#1e2528]">
      <aside className="hidden w-80 shrink-0 border-r border-[#dfe5e2] bg-white lg:flex lg:flex-col">
        <div className="border-b border-[#e5e9e7] p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#173f3f] text-white">
              <Building2 size={21} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#1f2a2d]">Acme Data Room</p>
              <p className="truncate text-xs text-[#667478]">{user.email}</p>
            </div>
          </div>
          <Button className="mt-4 w-full" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            New data room
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3 thin-scrollbar">
          <div className="mb-5">
            <div className="mb-2 flex items-center justify-between px-2">
              <p className="text-xs font-semibold uppercase text-[#7b888b]">Owned</p>
              <IconButton title="Refresh" onClick={loadRooms}>
                <RefreshCw size={15} />
              </IconButton>
            </div>
            {loading ? (
              <div className="px-2 text-sm text-[#667478]">Loading</div>
            ) : rooms.owned.length === 0 ? (
              <p className="px-2 text-sm text-[#667478]">No data rooms yet.</p>
            ) : (
              <div className="space-y-1">
                {rooms.owned.map((room) => (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => navigate(`/rooms/${room.id}/folders/${room.rootFolderId}`)}
                    className={`w-full rounded-md px-3 py-3 text-left transition ${
                      currentRoom?.id === room.id ? "bg-[#e8f4f3]" : "hover:bg-[#f3f6f4]"
                    }`}
                  >
                    <span className="block truncate text-sm font-semibold text-[#263235]">{room.name}</span>
                    <span className="mt-1 block text-xs text-[#667478]">
                      {pluralize(room.fileCount, "file")} · {formatBytes(room.sizeBytes)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 px-2 text-xs font-semibold uppercase text-[#7b888b]">Shared with me</p>
            {rooms.shared.length === 0 ? (
              <p className="px-2 text-sm text-[#667478]">No active invitations.</p>
            ) : (
              <div className="space-y-1">
                {rooms.shared.map((share) => (
                  <button
                    key={share.id}
                    type="button"
                    onClick={() => navigate(`/share/${share.token}`)}
                    className="w-full rounded-md px-3 py-3 text-left transition hover:bg-[#f3f6f4]"
                  >
                    <span className="flex items-center gap-2 truncate text-sm font-semibold text-[#263235]">
                      <Share2 size={15} />
                      {share.label}
                    </span>
                    <span className="mt-1 block text-xs text-[#667478]">{share.owner.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-[#e5e9e7] p-3">
          <Button variant="ghost" className="w-full justify-start" onClick={logout}>
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-[#dfe5e2] bg-white px-4 lg:hidden">
          <div className="flex items-center gap-2">
            <Building2 size={20} />
            <span className="text-sm font-semibold">Acme Data Room</span>
          </div>
          <div className="flex gap-1">
            <IconButton title="New data room" onClick={() => setCreateOpen(true)}>
              <Plus size={17} />
            </IconButton>
            <IconButton title="Sign out" onClick={logout}>
              <LogOut size={17} />
            </IconButton>
          </div>
        </header>

        {error ? (
          <div className="border-b border-[#efc8bd] bg-[#fff1ed] px-5 py-2 text-sm text-[#8b321f]">{error}</div>
        ) : null}

        {route.kind === "room" && currentRoom ? (
          <DataRoomBrowser
            roomId={route.roomId}
            folderId={route.folderId}
            onOpenFolder={(nextFolderId) => navigate(`/rooms/${route.roomId}/folders/${nextFolderId}`)}
            onRoomMutated={loadRooms}
          />
        ) : (
          <WorkspaceHome rooms={rooms} totals={totals} onCreate={() => setCreateOpen(true)} />
        )}
      </section>

      {createOpen ? (
        <Modal title="New data room" onClose={() => setCreateOpen(false)}>
          <form onSubmit={createRoom} className="space-y-4">
            <TextInput value={roomName} onChange={(event) => setRoomName(event.target.value)} autoFocus />
            <Button disabled={saving} className="w-full">
              {saving ? <Spinner /> : null}
              Create
            </Button>
          </form>
        </Modal>
      ) : null}
    </main>
  );
}

function WorkspaceHome({
  rooms,
  totals,
  onCreate
}: {
  rooms: RoomsPayload;
  totals: { sizeBytes: number; fileCount: number; folderCount: number };
  onCreate: () => void;
}) {
  if (rooms.owned.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          title="No data rooms yet"
          detail="Create the first room for the acquisition workspace."
          action={
            <Button onClick={onCreate}>
              <Plus size={16} />
              New data room
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6 thin-scrollbar">
      <div className="grid gap-4 md:grid-cols-3">
        <SummaryTile icon={<Database size={20} />} label="Storage" value={formatBytes(totals.sizeBytes)} />
        <SummaryTile icon={<FileText size={20} />} label="Files" value={String(totals.fileCount)} />
        <SummaryTile icon={<FolderOpen size={20} />} label="Folders" value={String(totals.folderCount)} />
      </div>
      <div className="mt-6 overflow-hidden rounded-lg border border-[#dbe2df] bg-white">
        <div className="border-b border-[#e5e9e7] px-4 py-3">
          <h1 className="text-lg font-semibold text-[#1f2a2d]">Recent data rooms</h1>
        </div>
        {rooms.owned.map((room) => (
          <button
            key={room.id}
            type="button"
            onClick={() => navigate(`/rooms/${room.id}/folders/${room.rootFolderId}`)}
            className="grid w-full gap-3 border-b border-[#eef2f0] px-4 py-4 text-left last:border-b-0 hover:bg-[#f7f9f8] md:grid-cols-[1fr_140px_140px]"
          >
            <span>
              <span className="block text-sm font-semibold text-[#253033]">{room.name}</span>
              <span className="mt-1 block text-xs text-[#667478]">{formatDate(room.updatedAt)}</span>
            </span>
            <span className="text-sm text-[#667478]">{pluralize(room.fileCount, "file")}</span>
            <span className="text-sm text-[#667478]">{formatBytes(room.sizeBytes)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#dbe2df] bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="text-[#0f7779]">{icon}</span>
        <ShieldCheck size={17} className="text-[#91a09f]" />
      </div>
      <p className="mt-4 text-2xl font-semibold text-[#1f2a2d]">{value}</p>
      <p className="mt-1 text-sm text-[#667478]">{label}</p>
    </div>
  );
}

function ShareView({
  token,
  user,
  onAuth
}: {
  token: string;
  user: User | null;
  onAuth: (user: User) => void;
}) {
  const [resolved, setResolved] = useState<ShareResolveResponse | null>(null);
  const [folderId, setFolderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [needsAuth, setNeedsAuth] = useState(false);

  const loadShare = useCallback(async () => {
    setLoading(true);
    setError("");
    setNeedsAuth(false);
    try {
      const payload = await request<ShareResolveResponse>(`/api/shares/${token}/resolve`);
      setResolved(payload);
      if (payload.resource.folderId) setFolderId(payload.resource.folderId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsAuth(true);
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not open share");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadShare();
  }, [loadShare, user?.id]);

  if (needsAuth) {
    return <AuthView message={error} onAuth={onAuth} />;
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[#667478]">
        <Spinner />
        <span className="ml-2">Opening share</span>
      </main>
    );
  }

  if (error || !resolved) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <EmptyState title={error || "Share not found"} detail="The owner may have revoked access or deleted the item." />
      </main>
    );
  }

  if (resolved.resource.type === "FILE" && resolved.resource.fileId) {
    return (
      <main className="flex min-h-screen flex-col bg-[#f4f6f5]">
        <header className="flex items-center justify-between border-b border-[#dfe5e2] bg-white px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#1f2a2d]">{resolved.resource.label}</p>
            <p className="truncate text-xs text-[#667478]">Shared by {resolved.resource.owner.email}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => window.open(fileContentUrl(resolved.resource.fileId!, token, true), "_blank", "noopener,noreferrer")}
          >
            Download
          </Button>
        </header>
        <div className="min-h-0 flex-1 p-4">
          <iframe
            title={resolved.resource.label}
            src={fileContentUrl(resolved.resource.fileId, token)}
            className="h-[calc(100vh-104px)] w-full rounded-lg border border-[#d7ddda] bg-white"
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-[680px] flex-col bg-[#f4f6f5]">
      <header className="flex items-center justify-between border-b border-[#dfe5e2] bg-white px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#1f2a2d]">{resolved.resource.label}</p>
          <p className="truncate text-xs text-[#667478]">Shared by {resolved.resource.owner.email}</p>
        </div>
        <span className="rounded-full bg-[#edf2f1] px-2.5 py-1 text-xs font-medium text-[#667478]">Read-only</span>
      </header>
      <div className="min-h-0 flex-1">
        <DataRoomBrowser
          roomId={resolved.resource.roomId}
          folderId={folderId}
          token={token}
          onOpenFolder={setFolderId}
        />
      </div>
    </main>
  );
}

export default App;
