import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';
import { Link } from 'wouter';

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2">
            <AlertCircle className="h-8 w-8 text-red-500" />
            <h1 className="text-2xl font-bold text-foreground">
              404 Page Not Found
            </h1>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            This page doesn’t exist or may have moved.
          </p>
          <Link href="/studio" className="mt-4 inline-block text-primary underline">Return to Studio</Link>
        </CardContent>
      </Card>
    </div>
  );
}
