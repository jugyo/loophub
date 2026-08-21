// Settings > Notifications screen (/settings/notifications, #2508). Instance-level settings for how
// arriving notifications announce themselves, persisted through config.json like the Agent screen's.

import { SettingsLayout } from "@/components/settings-header";
import { Switch } from "@/components/ui/switch";
import { useSettings, useUpdateSettings } from "@/queries/settings";

export function NotificationSettingsPage() {
  const { data } = useSettings();
  const update = useUpdateSettings();
  const notificationSound = data?.notificationSound ?? true;

  return (
    <div data-debug-component="NotificationSettingsPage">
      <SettingsLayout section="notifications">
        <section
          data-debug-component="NotificationSoundSettings"
          className="max-w-md"
        >
          <h2 className="text-sm font-medium">Notification sound</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ring a bell when a new notification arrives, so an unattended screen
            is noticed by ear.
          </p>
          <Switch
            className="mt-3"
            label="Play a sound"
            checked={notificationSound}
            onCheckedChange={(checked) =>
              update.mutate({ notificationSound: checked })
            }
          />
        </section>
      </SettingsLayout>
    </div>
  );
}
