import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { videoSupport, type Settings, type VideoSupport } from "../ipc";
import { type Change, Row, Section, Slider } from "./controls";

export function ConversionTab({
  settings,
  error,
  change,
}: {
  settings: Settings;
  error?: string;
  change: Change;
}) {
  const [video, setVideo] = useState<VideoSupport | null>(
    isTauri() ? null : { available: true, installHint: "brew install ffmpeg" },
  );
  useEffect(() => {
    if (isTauri()) void videoSupport().then(setVideo);
  }, []);

  return (
    <>
      <Section
        title={t("settings.conversion.quality.title")}
        error={error}
        note={t("settings.conversion.quality.note")}
      >
        {(
          [
            ["JPEG", "jpegQuality"],
            ["WebP", "webpQuality"],
            ["AVIF", "avifQuality"],
          ] as const
        ).map(([label, key]) => (
          <Row key={key} label={label}>
            <Slider
              label={t("settings.conversion.quality.aria", { format: label })}
              value={settings[key]}
              min={1}
              max={100}
              showValue
              onCommit={(value) => change("quality", { [key]: value })}
            />
          </Row>
        ))}
      </Section>

      <Section title={t("settings.conversion.vector.title")}>
        <p className="section-note">{t("settings.conversion.vector.note")}</p>
      </Section>

      <Section title={t("settings.conversion.videos.title")}>
        <Row
          label="FFmpeg"
          hint={
            video === null
              ? t("settings.conversion.videos.searching")
              : video.available
                ? t("settings.conversion.videos.available")
                : t("settings.conversion.videos.install", { command: video.installHint })
          }
        >
          {video && (
            <span className="status" data-state={video.available ? "granted" : "denied"}>
              {video.available ? t("settings.conversion.videos.installed") : t("settings.conversion.videos.missing")}
            </span>
          )}
        </Row>
      </Section>
    </>
  );
}
