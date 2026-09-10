import { useState, useMemo, useEffect } from "react";
import {
  useGetSession,
  useListTenants,
  useGetSpendingReport,
  getGetSpendingReportQueryKey,
  useListSpendingEntries,
  getListSpendingEntriesQueryKey,
  useUpdateTenantMemberSpendingLimit,
  SpendingReportRow
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { Page, PageHeader } from "@/components/layout/page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Coins, Receipt, ArrowRightLeft, UserCircle, Edit2, ShieldAlert, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export default function SpendingPage() {
  const { data: session } = useGetSession();
  const isSiteAdmin = session?.user?.siteRole === "SITE_ADMIN";

  const currentMonthStr = new Date().toISOString().substring(0, 7);
  const [month, setMonth] = useState(currentMonthStr);

  const [selectedTenantId, setSelectedTenantId] = useState<string>("all");

  const queryTenantId = selectedTenantId === "all" ? undefined : selectedTenantId;

  return (
    <Page>
      <PageHeader
        title="Spending & Limits"
        description="Track monthly cloud API costs, pending reservations, and user limits."
        actions={
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-48"
              max={currentMonthStr}
            />
            {isSiteAdmin && (
              <TenantSelector
                value={selectedTenantId}
                onChange={setSelectedTenantId}
              />
            )}
          </div>
        }
      />

      <div className="space-y-8 animate-in fade-in duration-500 pb-8">
        <SpendingOverview month={month} tenantId={queryTenantId} />

        <div className="text-xs text-muted-foreground bg-secondary/30 p-3 rounded-md border border-border/50">
          <strong>Note:</strong> Some providers report final bills later. "Estimated" amounts are pending confirmation. We do not claim all estimated spend as final until the actual billed amount is known.
        </div>

        <Tabs defaultValue="members" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="members" className="gap-2"><UserCircle className="size-4" /> User Limits & Totals</TabsTrigger>
            <TabsTrigger value="ledger" className="gap-2"><Receipt className="size-4" /> Ledger Entries</TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="space-y-4">
            <MembersSpendingTable month={month} tenantId={queryTenantId} />
          </TabsContent>

          <TabsContent value="ledger" className="space-y-4">
            <LedgerTable month={month} tenantId={queryTenantId} />
          </TabsContent>
        </Tabs>
      </div>
    </Page>
  );
}

function TenantSelector({ value, onChange }: { value: string, onChange: (v: string) => void }) {
  const { data: tenants } = useListTenants();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select Workspace" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Workspaces</SelectItem>
        {tenants?.map(t => (
          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SpendingOverview({ month, tenantId }: { month: string, tenantId?: string }) {
  const { data: report, isLoading, error } = useGetSpendingReport(
    { month, tenantId },
    {
      query: {
        refetchInterval: 30000, // Dynamic 30s refresh requested
        queryKey: getGetSpendingReportQueryKey({ month, tenantId })
      }
    }
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[1, 2, 3, 4].map(i => (
          <Card key={i} className="animate-pulse bg-card/50">
            <CardHeader className="pb-2"><div className="h-4 bg-secondary rounded w-24"></div></CardHeader>
            <CardContent><div className="h-8 bg-secondary rounded w-32"></div></CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded-lg flex items-center gap-3">
        <ShieldAlert className="size-5" />
        <div>
          <p className="font-medium">Failed to load spending totals</p>
          <p className="text-sm opacity-80">{(error as Error).message || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  const { totals } = report || { totals: { actualUSD: 0, estimatedUSD: 0, reservedUSD: 0, totalUSD: 0 } };

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-2">
      <Card className="border-border/50 bg-card/30 backdrop-blur-sm shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Coins className="size-4 text-blue-500" /> Billed (Actual)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">${totals.actualUSD.toFixed(2)}</div>
          <p className="text-xs text-muted-foreground mt-1">Confirmed provider costs</p>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/30 backdrop-blur-sm shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Coins className="size-4 text-emerald-500" /> Estimated
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">${totals.estimatedUSD.toFixed(2)}</div>
          <p className="text-xs text-muted-foreground mt-1">Pending final bill</p>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/30 backdrop-blur-sm shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <ArrowRightLeft className="size-4 text-amber-500" /> Reserved
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono">${totals.reservedUSD.toFixed(2)}</div>
          <p className="text-xs text-muted-foreground mt-1">In-flight generations</p>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/30 backdrop-blur-sm shadow-sm relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
          <Receipt className="size-24" />
        </div>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            Total Consumption
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold font-mono text-primary">${totals.totalUSD.toFixed(2)}</div>
          <p className="text-xs text-muted-foreground mt-1">Counted against limits</p>
        </CardContent>
      </Card>
    </div>
  );
}

function MembersSpendingTable({ month, tenantId }: { month: string, tenantId?: string }) {
  const { data: report, isLoading, error } = useGetSpendingReport(
    { month, tenantId },
    {
      query: {
        refetchInterval: 30000,
        queryKey: getGetSpendingReportQueryKey({ month, tenantId })
      }
    }
  );

  if (isLoading) return <div className="py-12 text-center text-muted-foreground">Loading members spending...</div>;
  if (error) return <div className="py-12 text-center text-destructive">Failed to load members spending</div>;

  if (!report?.rows.length && !report?.pendingInvitations?.length) {
    return (
      <Card className="border-dashed bg-card/20">
        <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <UserCircle className="size-12 mb-4 opacity-20" />
          <p>No active users or spending recorded for this period.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-secondary/50">
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Workspace / Role</TableHead>
              <TableHead className="text-right">Consumed</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report?.rows.map((row, idx) => (
              <TableRow key={`${row.tenantId}-${row.userId}-${idx}`} className="group hover:bg-secondary/20">
                <TableCell>
                  <div className="font-medium">{row.userDisplayName}</div>
                  <div className="text-xs text-muted-foreground">{row.userEmail || "No email"}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="text-sm">{row.tenantName}</span>
                    <Badge variant="outline" className="w-fit text-[10px] uppercase tracking-wider">{row.role}</Badge>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="font-mono font-medium">${row.totalUSD.toFixed(2)}</div>
                  <div className="text-[10px] flex flex-col items-end gap-0.5 mt-0.5">
                    {row.actualUSD > 0 && <span className="text-blue-500 font-mono" title="Confirmed provider costs">billed ${row.actualUSD.toFixed(2)}</span>}
                    {row.estimatedUSD > 0 && <span className="text-emerald-500 font-mono" title="Pending final bill">est ${row.estimatedUSD.toFixed(2)}</span>}
                    {row.reservedUSD > 0 && <span className="text-amber-500 font-mono" title="In-flight generations">rsv ${row.reservedUSD.toFixed(2)}</span>}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {row.monthlyLimitUsd === null ? (
                    <Badge variant="secondary" className="font-normal">Unlimited</Badge>
                  ) : (
                    <span className="font-mono font-medium">${row.monthlyLimitUsd.toFixed(2)}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {row.monthlyLimitUsd === null ? (
                    <span className="text-muted-foreground text-sm">∞</span>
                  ) : (
                    <LimitRemaining
                      consumed={row.totalUSD}
                      limit={row.monthlyLimitUsd}
                    />
                  )}
                </TableCell>
                <TableCell>
                  {row.canManageLimit && (
                    <EditLimitDialog row={row} month={month} tenantIdQuery={tenantId} />
                  )}
                </TableCell>
              </TableRow>
            ))}

            {report?.pendingInvitations?.map((inv, idx) => (
              <TableRow key={`inv-${inv.id}-${idx}`} className="bg-secondary/10 opacity-70">
                <TableCell>
                  <div className="font-medium italic text-muted-foreground">{inv.email}</div>
                  <Badge variant="secondary" className="text-[10px]">Pending Invite</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="w-fit text-[10px] uppercase">{inv.role}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">$0.00</TableCell>
                <TableCell className="text-right">
                  {inv.monthlyLimitUsd === null ? (
                    <Badge variant="secondary" className="font-normal opacity-50">Unlimited</Badge>
                  ) : (
                    <span className="font-mono text-muted-foreground">${inv.monthlyLimitUsd.toFixed(2)}</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">-</TableCell>
                <TableCell></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function LimitRemaining({ consumed, limit }: { consumed: number, limit: number }) {
  const remaining = Math.max(0, limit - consumed);
  const ratio = consumed / limit;

  let colorClass = "text-emerald-500";
  if (ratio >= 0.9) colorClass = "text-destructive font-bold";
  else if (ratio >= 0.75) colorClass = "text-amber-500";

  return (
    <span className={`font-mono ${colorClass}`}>
      ${remaining.toFixed(2)}
    </span>
  );
}

function EditLimitDialog({ row, month, tenantIdQuery }: { row: SpendingReportRow, month: string, tenantIdQuery?: string }) {
  const [open, setOpen] = useState(false);
  const [limitInput, setLimitInput] = useState<string>("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateLimit = useUpdateTenantMemberSpendingLimit({
    mutation: {
      onSuccess: () => {
        toast({ title: "Limit updated", description: "The monthly spending limit has been updated." });
        setOpen(false);
        // Invalidate to refresh the table without losing other data
        queryClient.invalidateQueries({
          queryKey: getGetSpendingReportQueryKey({ month, tenantId: tenantIdQuery })
        });
      },
      onError: (err) => {
        toast({
          title: "Update failed",
          description: (err as Error).message || "Could not update limit.",
          variant: "destructive"
        });
      }
    }
  });

  const handleOpen = () => {
    setLimitInput(row.monthlyLimitUsd === null ? "" : row.monthlyLimitUsd.toString());
    setOpen(true);
  };

  const handleSave = () => {
    let parsedLimit: number | null = null;
    if (limitInput.trim() !== "") {
      parsedLimit = Number(limitInput);
      if (isNaN(parsedLimit) || parsedLimit < 0 || parsedLimit > 1000000) {
        toast({ title: "Invalid limit", description: "Must be a non-negative number up to 1,000,000", variant: "destructive" });
        return;
      }
    }

    updateLimit.mutate({
      tenantId: row.tenantId,
      userId: row.userId,
      data: { monthlyLimitUsd: parsedLimit }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" onClick={handleOpen} className="size-8 text-muted-foreground hover:text-foreground">
          <Edit2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Monthly Limit</DialogTitle>
          <DialogDescription>
            Set the monthly spending limit for <strong>{row.userDisplayName}</strong> in {row.tenantName}.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label>Monthly Limit (USD)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="1000000"
              placeholder="Leave blank for unlimited"
              value={limitInput}
              onChange={e => setLimitInput(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A limit of 0 completely blocks paid Cloud generation. <br />
              Leave blank to allow unlimited spending.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateLimit.isPending}>
            {updateLimit.isPending ? "Saving..." : "Save Limit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LedgerTable({ month, tenantId }: { month: string, tenantId?: string }) {
  const [page, setPage] = useState(1);
  const pageSize = 20;

  // Reset page when month or tenant changes
  useEffect(() => { setPage(1); }, [month, tenantId]);

  const { data: ledger, isLoading, error } = useListSpendingEntries(
    { month, tenantId, page, pageSize },
    {
      query: {
        refetchInterval: 30000,
        enabled: !!month,
        queryKey: getListSpendingEntriesQueryKey({ month, tenantId, page, pageSize })
      }
    }
  );

  if (isLoading) return <div className="py-12 text-center text-muted-foreground">Loading ledger entries...</div>;
  if (error) return <div className="py-12 text-center text-destructive">Failed to load ledger entries</div>;

  if (!ledger?.entries.length) {
    return (
      <Card className="border-dashed bg-card/20">
        <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Receipt className="size-12 mb-4 opacity-20" />
          <p>No transactions recorded for this period.</p>
        </CardContent>
      </Card>
    );
  }

  const totalPages = Math.ceil(ledger.total / pageSize);

  return (
    <div className="space-y-4">
      <Card className="border-border/50 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-secondary/50">
              <TableRow>
                <TableHead>Time (UTC)</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Model / Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.entries.map((entry) => (
                <TableRow key={entry.id} className="hover:bg-secondary/20 group">
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {format(new Date(entry.submittedAt), "MMM d, HH:mm")}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{entry.userDisplayName}</div>
                    <div className="text-xs text-muted-foreground">{entry.userEmail}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="uppercase text-[10px]">{entry.sourceType}</Badge>
                    <div className="text-[10px] text-muted-foreground truncate w-24 opacity-0 group-hover:opacity-100 transition-opacity" title={entry.sourceId}>
                      {entry.sourceId}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm max-w-[200px] truncate" title={entry.modelId}>
                      {entry.modelId}
                    </div>
                    {entry.note && (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]" title={entry.note}>
                        {entry.note}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge outcome={entry.outcome} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className={`font-mono text-sm ${entry.outcome === 'released' ? 'line-through opacity-50' : ''}`}>
                      ${(entry.actualUSD !== null ? entry.actualUSD : entry.reservedUSD).toFixed(2)}
                    </div>
                    {entry.pricingNote && (
                      <div className="text-[10px] text-muted-foreground">
                        {entry.pricingNote}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, ledger.total)} of {ledger.total}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              Previous
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ outcome }: { outcome: string }) {
  switch (outcome) {
    case 'reserved':
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20">Reserved</Badge>;
    case 'estimated':
      return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Estimated</Badge>;
    case 'actual':
      return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20">Billed</Badge>;
    case 'released':
      return <Badge variant="outline" className="bg-secondary text-secondary-foreground border-border">Released</Badge>;
    case 'uncertain':
      return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 flex items-center gap-1"><AlertCircle className="size-3"/> Error</Badge>;
    default:
      return <Badge variant="secondary">{outcome}</Badge>;
  }
}
