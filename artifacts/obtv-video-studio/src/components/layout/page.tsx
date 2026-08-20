import { ReactNode } from "react";

export function Page({ children, className = "" }: { children: ReactNode, className?: string }) {
  return (
    <div className={`flex-1 overflow-y-auto w-full h-full ${className}`}>
      <div className="max-w-7xl mx-auto p-8 w-full">
        {children}
      </div>
    </div>
  );
}

export function PageHeader({ 
  title, 
  description,
  actions
}: { 
  title: string; 
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8 pb-4 border-b border-border/50">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}