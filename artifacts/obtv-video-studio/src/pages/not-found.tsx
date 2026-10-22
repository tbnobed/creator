import { Compass } from "lucide-react";
import { Link } from "wouter";
import { Page } from "@/components/layout/page";

export default function NotFound() {
  return (
    <Page>
      <div className="mx-auto flex max-w-md flex-col items-center rounded-xl border border-dashed border-border/60 bg-card/30 px-6 py-16 text-center" data-testid="page-not-found">
        <Compass className="mb-4 size-10 text-primary" />
        <h1 className="text-2xl font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">This page does not exist or may have moved.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/studio" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="link-notfound-studio">Generate Video</Link>
          <Link href="/generations" className="rounded-md border border-border px-4 py-2 text-sm" data-testid="link-notfound-queue">Queue &amp; History</Link>
        </div>
      </div>
    </Page>
  );
}
