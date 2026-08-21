// Advanced instance settings, including network access controls.

import { useEffect, useState } from "react";
import { SettingsLayout } from "@/components/settings-header";
import { Button } from "@/components/ui/button";
import { useSettings, useUpdateSettings } from "@/queries/settings";

export function AdvancedSettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [publicOriginInput, setPublicOriginInput] = useState("");

  useEffect(() => {
    setPublicOriginInput(data?.publicOrigin ?? "");
  }, [data?.publicOrigin]);

  const publicOriginChanged = publicOriginInput !== (data?.publicOrigin ?? "");

  return (
    <div data-debug-component="AdvancedSettingsPage">
      <SettingsLayout section="advanced">
        <section
          data-debug-component="NetworkAccessSettings"
          className="max-w-2xl"
        >
          <h2 className="text-sm font-medium">Network access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Allow this exact HTTPS origin to call LoopHub&apos;s high-privilege
            RPC after Cloudflare Access authentication. Leave blank for
            loopback-only access.
          </p>
          <form
            className="mt-3 flex items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!publicOriginChanged) return;
              update.mutate({ publicOrigin: publicOriginInput.trim() || null });
            }}
          >
            <label className="flex-1 text-sm">
              <span className="sr-only">Public origin</span>
              <input
                type="url"
                value={publicOriginInput}
                disabled={isLoading || update.isPending}
                aria-label="Public origin"
                placeholder="https://loop.example.com"
                className="w-full rounded-md border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onChange={(event) => setPublicOriginInput(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              variant="secondary"
              disabled={isLoading || update.isPending || !publicOriginChanged}
            >
              Save
            </Button>
          </form>
        </section>
      </SettingsLayout>
    </div>
  );
}
