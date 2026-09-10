import { useState } from "react";
import { 
  useGetSession, 
  useLogout,
  useListTenants, 
  useCreateTenant, 
  useActivateTenant,
  useListTenantMembers,
  useAddTenantMember,
  useDeleteTenantMember
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { LogOut, Plus, CheckCircle2, UserPlus, Trash2, Building, UserCircle, Shield, Briefcase, Mail, BadgeCheck, Users, Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { publishAuthChanged } from "@/lib/auth-events";

export default function AccountPage() {
  const { data: session } = useGetSession();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        publishAuthChanged();
        setLocation("/");
      },
      onError: () => {
        toast({
          title: "Sign out failed",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  if (!session) return null;

  return (
    <div className="flex-1 p-6 md:p-8 max-w-5xl mx-auto w-full space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Account & Workspace</h1>
          <p className="text-muted-foreground mt-1">Manage your personal details and studio workspaces.</p>
        </div>
        <Button 
          variant="destructive" 
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="shrink-0 shadow-sm"
          data-testid="button-sign-out"
        >
          <LogOut className="size-4 mr-2" />
          {logout.isPending ? "Signing Out…" : "Sign Out"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-1 space-y-8">
          <Card className="border-border/50 shadow-sm bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserCircle className="size-5 text-primary" />
                Profile
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Display Name</p>
                <p className="text-foreground font-semibold">{session.user.displayName}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground font-medium">Email</p>
                <p className="text-foreground">{session.user.email || "No email"}</p>
              </div>
              <div className="space-y-1 pt-2">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary/80 border border-border text-xs font-medium">
                  <Shield className="size-3 text-muted-foreground" />
                  Role: <span className={session.user.siteRole === "SITE_ADMIN" ? "text-primary" : ""}>{session.user.siteRole}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2 space-y-8">
          <WorkspaceManager activeTenantId={session.activeTenant?.id} />
          
          {session.activeTenant && (
            <WorkspaceMembers 
              tenantId={session.activeTenant.id} 
              userRole={session.activeTenant.role} 
              currentUserId={session.user.id}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceManager({ activeTenantId }: { activeTenantId?: string }) {
  const { data: tenants, isLoading } = useListTenants();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const activateTenant = useActivateTenant({
    mutation: {
      onSuccess: () => {
        // Clear all query caches to remove tenant-scoped data
        queryClient.clear();
        toast({
          title: "Workspace Changed",
          description: "Your active workspace has been updated.",
        });
        setLocation('/studio');
      },
      onError: (err) => {
        toast({
          title: "Error",
          description: (err as Error).message || "Failed to switch workspace",
          variant: "destructive"
        });
      }
    }
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [newTenantName, setNewTenantName] = useState("");
  
  const createTenant = useCreateTenant({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        setCreateOpen(false);
        setNewTenantName("");
        toast({
          title: "Workspace Created",
          description: "New workspace has been created and activated.",
        });
        setLocation('/studio');
      },
      onError: (err) => {
        toast({
          title: "Error",
          description: (err as Error).message || "Failed to create workspace",
          variant: "destructive"
        });
      }
    }
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTenantName.trim()) return;
    createTenant.mutate({ data: { name: newTenantName } });
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Building className="size-5 text-primary" />
            Workspaces
          </CardTitle>
          <CardDescription>Select your active studio workspace</CardDescription>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="shrink-0 bg-secondary/50">
              <Plus className="size-4 mr-1.5" />
              New Workspace
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Create Workspace</DialogTitle>
                <DialogDescription>
                  Create a new studio workspace to organize your projects and team.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Workspace Name</Label>
                  <Input 
                    id="name" 
                    placeholder="e.g. My Studio, Marketing Team" 
                    value={newTenantName}
                    onChange={e => setNewTenantName(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={!newTenantName.trim() || createTenant.isPending}>
                  {createTenant.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Loading workspaces...</div>
        ) : !tenants?.length ? (
          <div className="py-8 text-center text-muted-foreground border border-dashed rounded-lg bg-secondary/20">
            You don't belong to any workspaces yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {tenants.map(tenant => {
              const isActive = tenant.id === activeTenantId;
              return (
                <div 
                  key={tenant.id} 
                  className={`flex items-center justify-between p-4 rounded-lg border transition-all ${
                    isActive 
                      ? "border-primary/50 bg-primary/5 shadow-[0_0_15px_rgba(255,31,98,0.1)]" 
                      : "border-border bg-card hover:border-primary/30 hover:bg-secondary/30"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`size-10 rounded-md flex items-center justify-center font-bold text-lg ${
                      isActive ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"
                    }`}>
                      {tenant.name.substring(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <h4 className="font-semibold text-foreground flex items-center gap-2">
                        {tenant.name}
                        {isActive && <BadgeCheck className="size-4 text-primary" />}
                      </h4>
                      <p className="text-xs text-muted-foreground mt-0.5">Role: {tenant.role}</p>
                    </div>
                  </div>
                  {!isActive && (
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      onClick={() => activateTenant.mutate({ id: tenant.id })}
                      disabled={activateTenant.isPending}
                    >
                      {activateTenant.isPending && activateTenant.variables?.id === tenant.id ? "Activating..." : "Switch"}
                    </Button>
                  )}
                  {isActive && (
                    <div className="text-sm font-medium text-primary flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10">
                      <CheckCircle2 className="size-4" />
                      Active
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkspaceMembers({ tenantId, userRole, currentUserId }: { tenantId: string, userRole: string, currentUserId: string }) {
  const { data: members, isLoading, refetch } = useListTenantMembers(tenantId);
  const { toast } = useToast();
  
  const canManageMembers = userRole === "OWNER" || userRole === "ADMIN";
  
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [newLimit, setNewLimit] = useState<string>("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [createdLimit, setCreatedLimit] = useState<number | null>(null);

  const addMember = useAddTenantMember({
    mutation: {
      onSuccess: (invitation) => {
        const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
        setInviteUrl(`${window.location.origin}${basePath}/sign-up?invite=${encodeURIComponent(invitation.token)}`);
        setCreatedLimit(invitation.monthlyLimitUsd ?? null);
        toast({ title: "Invitation created" });
      },
      onError: (err) => {
        toast({
          title: "Error",
          description: (err as Error).message || "Failed to add member",
          variant: "destructive"
        });
      }
    }
  });

  const deleteMember = useDeleteTenantMember({
    mutation: {
      onSuccess: () => {
        toast({ title: "Member Removed" });
        refetch();
      },
      onError: (err) => {
        toast({
          title: "Error",
          description: (err as Error).message || "Failed to remove member",
          variant: "destructive"
        });
      }
    }
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;

    let parsedLimit: number | null = null;
    if (newLimit.trim() !== "") {
      parsedLimit = Number(newLimit);
      if (isNaN(parsedLimit) || parsedLimit < 0) {
        toast({ title: "Invalid limit", description: "Must be a non-negative number", variant: "destructive" });
        return;
      }
    }

    addMember.mutate({ id: tenantId, data: { email: newEmail, role: newRole, monthlyLimitUsd: parsedLimit } });
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5 text-primary" />
            Members
          </CardTitle>
          <CardDescription>People with access to this workspace</CardDescription>
        </div>
        
        {canManageMembers && (
          <Dialog open={addOpen} onOpenChange={(open) => {
            setAddOpen(open);
            if (!open) {
              setInviteUrl("");
              setNewEmail("");
              setNewRole("MEMBER");
              setNewLimit("");
              setCreatedLimit(null);
            }
          }}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="shrink-0 bg-secondary/50">
                <UserPlus className="size-4 mr-1.5" />
                Invite User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleAdd}>
                <DialogHeader>
                  <DialogTitle>{inviteUrl ? "Invitation Ready" : "Invite Workspace Member"}</DialogTitle>
                  <DialogDescription>
                    {inviteUrl
                      ? "Send this one-time link to the intended recipient. It expires in seven days."
                      : "Access is granted only after the recipient signs in and accepts this invitation."}
                  </DialogDescription>
                </DialogHeader>
                {inviteUrl ? (
                  <div className="space-y-3 py-4">
                    <Label htmlFor="invite-url">Invitation Link</Label>
                    <Input id="invite-url" value={inviteUrl} readOnly data-testid="input-invitation-link" />
                    {createdLimit !== null && (
                      <p className="text-sm text-muted-foreground mt-2">
                        Monthly spending limit: <strong>${createdLimit.toFixed(2)}</strong>
                      </p>
                    )}
                    <p className="text-sm text-muted-foreground mt-2">Existing users will retain their current limit.</p>
                  </div>
                ) : <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email Address</Label>
                    <Input 
                      id="email" 
                      type="email"
                      placeholder="colleague@example.com" 
                      value={newEmail}
                      onChange={e => setNewEmail(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select value={newRole} onValueChange={(val: "MEMBER" | "ADMIN") => setNewRole(val)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MEMBER">Member (Can edit and generate)</SelectItem>
                        <SelectItem value="ADMIN">Admin (Can manage members)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="limit">Monthly Spending Limit (USD)</Label>
                    <Input
                      id="limit"
                      type="number"
                      step="0.01"
                      min="0"
                      max="1000000"
                      placeholder="e.g. 50 (Leave blank for unlimited)"
                      value={newLimit}
                      onChange={e => setNewLimit(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">0 blocks all paid usage. Unlimited if blank.</p>
                  </div>
                </div>}
                <DialogFooter>
                  {inviteUrl ? (
                    <>
                      <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Done</Button>
                      <Button type="button" onClick={async () => {
                        await navigator.clipboard.writeText(inviteUrl);
                        toast({ title: "Invitation link copied" });
                      }} data-testid="button-copy-invitation">
                        <Copy className="mr-2 size-4" />
                        Copy Link
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
                      <Button type="submit" disabled={!newEmail.trim() || addMember.isPending}>
                        {addMember.isPending ? "Creating..." : "Create Invitation"}
                      </Button>
                    </>
                  )}
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="py-4 text-center text-muted-foreground">Loading members...</div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <div className="divide-y divide-border">
              {members?.map(member => (
                <div key={member.userId} className="flex items-center justify-between p-3 sm:p-4 bg-card hover:bg-secondary/20 transition-colors">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className="size-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0 border border-primary/20">
                      {member.displayName.substring(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2">
                        <span className="truncate">{member.displayName}</span>
                        {member.userId === currentUserId && (
                          <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground border border-border">You</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <Mail className="size-3" />
                        <span className="truncate">{member.email || "No email"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 ml-4">
                    <div className="text-xs font-medium px-2 py-1 rounded bg-secondary text-secondary-foreground border border-border">
                      {member.role}
                    </div>
                    {canManageMembers && member.userId !== currentUserId && member.role !== "OWNER" && (
                      <Button 
                        variant="ghost" 
                        size="icon"
                        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 -mr-2 size-8"
                        onClick={() => {
                          if (confirm(`Remove ${member.displayName} from the workspace?`)) {
                            deleteMember.mutate({ id: tenantId, userId: member.userId });
                          }
                        }}
                        disabled={deleteMember.isPending}
                        title="Remove member"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
