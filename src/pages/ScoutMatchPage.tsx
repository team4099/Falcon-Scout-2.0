import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { useCached } from "@/hooks/useCached";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FormField, FormData, FormType } from "@/types";
import { FORM_TYPE_ORDER, formTypeRank } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Minus, Plus, Send, WifiOff, Wifi, ClipboardList, ChevronRight, Star, Camera, ImageUp, X } from "lucide-react";
import {
  enqueueOfflineSubmission,
} from "@/lib/offlineQueue";
import { saveMySubmission } from "@/lib/submissionStore";
import { useOfflineSync } from "@/hooks/useOfflineSync";
import { fetchTBAEventTeams, type TBATeam } from "@/lib/api";
import { compressImageFile } from "@/lib/imageCompress";

// ──────────────────────────────────────────────
// Counter widget
// ──────────────────────────────────────────────
function Counter({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="icon"
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        className="h-9 w-9"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <span className="w-12 text-center text-xl font-bold font-mono tabular-nums">
        {value}
      </span>
      <Button
        variant="outline"
        size="icon"
        type="button"
        onClick={() => onChange(value + 1)}
        className="h-9 w-9 border-primary/50 hover:bg-primary hover:text-primary-foreground"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Star rating widget
// ──────────────────────────────────────────────
function StarRating({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const display = hovered ?? value;
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: max }).map((_, i) => {
        const n = i + 1;
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onChange(value === n ? 0 : n)}
            className="focus:outline-none transition-transform hover:scale-110 active:scale-95"
            aria-label={`Rate ${n} out of ${max}`}
          >
            <Star
              className={`h-8 w-8 transition-colors ${
                filled
                  ? "text-yellow-400 fill-yellow-400"
                  : "text-muted-foreground/30"
              }`}
            />
          </button>
        );
      })}
      {value > 0 && (
        <span className="ml-2 text-sm text-muted-foreground font-mono">{value}/{max}</span>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Photo field — take a new photo or pick one from the library
// ──────────────────────────────────────────────
function PhotoField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await compressImageFile(file);
      onChange(dataUrl);
    } catch {
      toast.error("Couldn't process that photo — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }}
      />
      {value ? (
        <div className="relative inline-block">
          <img
            src={value}
            alt="Attached"
            className="h-32 w-auto rounded-md border border-border object-cover"
          />
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow"
            aria-label="Remove photo"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            variant="outline" size="sm" type="button" disabled={busy}
            onClick={() => cameraInputRef.current?.click()}
          >
            <Camera className="h-4 w-4 mr-1" /> Take Photo
          </Button>
          <Button
            variant="outline" size="sm" type="button" disabled={busy}
            onClick={() => libraryInputRef.current?.click()}
          >
            <ImageUp className="h-4 w-4 mr-1" /> Choose Photo
          </Button>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Single field renderer
// ──────────────────────────────────────────────
function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FormData[string];
  onChange: (v: FormData[string]) => void;
}) {
  switch (field.type) {
    case "rating": {
      const max = Number(field.options?.[0] ?? "5");
      return (
        <StarRating
          value={(value as number) ?? 0}
          max={max}
          onChange={(v) => onChange(v)}
        />
      );
    }
    case "teamNumber":
      // Free entry — validated against the event roster at submit (client + server).
      return (
        <Input
          type="number"
          value={(value as number) || ""}
          placeholder="e.g. 4099"
          min={1}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case "text":
      return (
        <Input
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
        />
      );
    case "textarea":
      return (
        <Textarea
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          rows={3}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          value={(value as number) ?? 0}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case "counter":
      return (
        <Counter
          value={(value as number) ?? 0}
          onChange={(v) => onChange(v)}
        />
      );
    case "checkbox":
      return (
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id={field.id}
            checked={!!(value as boolean)}
            onCheckedChange={(c) => onChange(!!c)}
          />
          <Label htmlFor={field.id} className="font-normal cursor-pointer">
            {field.label}
          </Label>
        </div>
      );
    case "select":
      return (
        <Select
          value={(value as string) ?? ""}
          onValueChange={(v) => onChange(v || "")}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select an option…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "photo":
      return (
        <PhotoField
          value={value as string | undefined}
          onChange={(v) => onChange(v ?? "")}
        />
      );
  }
}

// ──────────────────────────────────────────────
// Form Picker — shown when multiple forms are active
// ──────────────────────────────────────────────
type ActiveTemplate = {
  _id: string;
  name: string;
  description?: string;
  fields: FormField[];
  isActive: boolean;
};

function FormPicker({
  templates,
  onSelect,
}: {
  templates: ActiveTemplate[];
  onSelect: (t: ActiveTemplate) => void;
}) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h2 className="text-2xl font-bold tracking-tight">Scout Match</h2>
        <p className="text-muted-foreground text-sm mt-1">
          Multiple scouting forms are active. Pick one to fill out.
        </p>
      </div>
      <div className="space-y-3">
        {[...templates]
          .sort((a, b) =>
            formTypeRank((a as { formType?: string }).formType) -
            formTypeRank((b as { formType?: string }).formType)
          )
          .map((t) => (
          <button
            key={t._id}
            onClick={() => onSelect(t)}
            className="w-full text-left bg-card border border-border rounded-xl p-5 hover:border-primary/60 hover:bg-primary/5 transition-all group flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                <ClipboardList className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-base">{t.name}</p>
                {t.description && (
                  <p className="text-sm text-muted-foreground mt-0.5">{t.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {t.fields.length} field{t.fields.length !== 1 ? "s" : ""}
                  {t.fields.some((f) => f.type === "teamNumber") && " · includes team #"}
                </p>
              </div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Scout Match Entry Page
// ──────────────────────────────────────────────
export default function ScoutMatchPage() {
  const activeTemplatesLive = useQuery(api.forms.listActiveTemplates);
  const activeTemplates = useCached(activeTemplatesLive, "active_templates");

  const currentEventLive = useQuery(api.events.getCurrentEvent);
  const currentEvent = useCached(currentEventLive, "current_event");

  const submitForm = useMutation(api.forms.submitForm);
  const syncRoster = useMutation(api.forms.syncEventTeamRoster);

  const { queueLength, refreshCounts } = useOfflineSync();
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;

  // Which form the scout picked (null = not yet chosen / only one)
  const [selectedTemplate, setSelectedTemplate] = useState<ActiveTemplate | null>(null);

  // Deep-link prefill: /scout?match=39&prefix=qm&team=254&form=default — used by
  // the cards in My Schedule so tapping an assignment lands on a form that is
  // already filled in. Read once on mount; after that the scout owns these
  // fields. `form` is a formType, not a template id, so the link keeps working
  // when an admin activates a different template mid-event.
  const [searchParams] = useSearchParams();
  // useState initialiser rather than a ref: this is read during render (and in
  // an effect dependency), which a ref does not allow.
  const [prefill] = useState(() => {
    const form = searchParams.get("form");
    return {
      match:  Number(searchParams.get("match")) || null,
      prefix: searchParams.get("prefix") === "elim" ? ("elim" as const) : null,
      team:   Number(searchParams.get("team")) || null,
      form:   FORM_TYPE_ORDER.includes(form as FormType) ? (form as FormType) : null,
      // An exact template id. Only checklists need it: several checklist
      // templates can be active at once and a scout is assigned a specific
      // one, which `form=checklist` alone cannot name. Falls back to `form=`
      // if the template has since been deactivated.
      template: searchParams.get("template"),
    };
  });
  // Whether the `form` deep-link has already picked a template. Without this,
  // "← Change form" would be undone by the effect below re-selecting it.
  const [deepLinkApplied, setDeepLinkApplied] = useState(false);

  const [matchNumber, setMatchNumber] = useState<number>(prefill.match ?? 1);
  const [matchPrefix, setMatchPrefix] = useState<"qm" | "elim">(prefill.prefix ?? "qm");
  const [formData, setFormData] = useState<FormData>({});
  const [submitting, setSubmitting] = useState(false);

  // Teams registered for the current event, used to validate the teamNumber
  // field on submit. Preloaded here so the check at submit time is instant;
  // re-fetched at submit time too in case this hasn't resolved yet.
  const [eventTeams, setEventTeams] = useState<TBATeam[] | null>(null);
  const eventTeamNumbers = useMemo(
    () => (eventTeams ? new Set(eventTeams.map((t) => t.team_number)) : null),
    [eventTeams]
  );
  useEffect(() => {
    const eventKey = currentEvent?.eventKey;
    if (!eventKey) {
      setEventTeams(null);
      return;
    }
    let cancelled = false;
    fetchTBAEventTeams(eventKey).then((teams) => {
      if (cancelled) return;
      if (Array.isArray(teams)) {
        setEventTeams(teams);
        // Sync the roster to Convex so the backend can validate team numbers
        syncRoster({ eventKey, teamNumbers: teams.map((t) => t.team_number) }).catch(() => {});
      } else {
        setEventTeams(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentEvent?.eventKey]);

  // Pick the template automatically where there's no real choice to make:
  // a `form=` deep-link from My Schedule, or a single active template.
  useEffect(() => {
    if (selectedTemplate || !activeTemplates?.length) return;
    if ((prefill.template || prefill.form) && !deepLinkApplied) {
      const list = activeTemplates as ActiveTemplate[];
      const match =
        (prefill.template && list.find((t) => t._id === prefill.template)) ||
        (prefill.form &&
          list.find(
            (t) => ((t as { formType?: string }).formType ?? "default") === prefill.form
          )) ||
        null;
      if (match) {
        setDeepLinkApplied(true);
        setSelectedTemplate(match);
        return;
      }
    }
    if (activeTemplates.length === 1) {
      setSelectedTemplate(activeTemplates[0] as ActiveTemplate);
    }
  }, [activeTemplates, selectedTemplate, prefill.form, prefill.template, deepLinkApplied]);

  // Reset form data when template changes. When the page was opened from a
  // schedule assignment, seed the first teamNumber field instead of clearing to
  // empty — the scout should land on a form that already knows who they have.
  useEffect(() => {
    const tpl = selectedTemplate;
    if (prefill.team && tpl) {
      const tf = ((tpl.fields ?? []) as FormField[]).find((f) => f.type === "teamNumber");
      if (tf) {
        setFormData({ [tf.id]: prefill.team });
        return;
      }
    }
    setFormData({});
  }, [selectedTemplate, prefill.team]);

  const template = selectedTemplate;
  const fields: FormField[] = (template?.fields ?? []) as FormField[];
  const templateFormType =
    ((template as { formType?: FormType } | null)?.formType ?? "default") as FormType;
  const isPitForm = templateFormType === "pit";
  const isChecklist = templateFormType === "checklist";
  // Checklists are per-match but are never elimination-match work (the pit
  // rotation that assigns them is quals-only), and they carry no team, so they
  // need the match number and nothing else.
  const heading = isPitForm ? "Scout Pit" : isChecklist ? "Checklist" : "Scout Match";
  const submitLabel = isPitForm
    ? "Submit Pit Data"
    : isChecklist
      ? "Submit Checklist"
      : "Submit Match Data";

  // Group fields by section
  const sections = fields.reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? "General";
    acc[key] = [...(acc[key] ?? []), f];
    return acc;
  }, {});

  function setValue(fieldId: string, value: FormData[string]) {
    setFormData((prev) => ({ ...prev, [fieldId]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!template) return;

    // The primary team number comes from the first teamNumber field in the form.
    // If no teamNumber field, fall back to 0 (anonymous / not required).
    const teamNumberFields = fields.filter((f) => f.type === "teamNumber");
    const primaryTeamNumber = teamNumberFields.length > 0
      ? (Number(formData[teamNumberFields[0].id]) || 0)
      : 0;

    // Validate: if form has teamNumber fields, at least the first must be filled
    if (teamNumberFields.length > 0 && primaryTeamNumber <= 0) {
      toast.error(`Please enter a valid team number in "${teamNumberFields[0].label}".`);
      return;
    }

    if (!currentEvent?.eventKey) {
      toast.error("No event selected. Please set an event in Settings.");
      return;
    }

    // Reject team numbers that aren't registered for the current event.
    // Re-fetch (cache-first, so this is instant once loaded — including
    // offline via stale cache) rather than trusting only the state set by
    // the background effect, since that may not have resolved yet.
    if (teamNumberFields.length > 0) {
      let roster = eventTeamNumbers;
      if (!roster) {
        const teams = await fetchTBAEventTeams(currentEvent.eventKey);
        if (Array.isArray(teams)) {
          setEventTeams(teams);
          roster = new Set(teams.map((t) => t.team_number));
        } else {
          roster = null;
        }
      }
      if (!roster) {
        toast.error(
          "Couldn't verify the team roster for this event. Connect online once (or check the TBA API key in Settings) so the roster can sync, then try again."
        );
        return;
      }
      if (!roster.has(primaryTeamNumber)) {
        toast.error(
          `Team ${primaryTeamNumber} is not registered at this event. Please enter a different team number.`
        );
        return;
      }
    }

    // Validate other required fields (teamNumber fields are always required when present).
    // Presence, not truthiness: 0 is a legitimate value for a counter, number or
    // rating ("scored nothing" is an observation, not a blank). A required
    // checkbox is the one type that must actually be ticked.
    const missing = fields.filter((f) => {
      if (f.type === "teamNumber") return !formData[f.id] || Number(formData[f.id]) <= 0;
      if (!f.required) return false;
      if (f.type === "checkbox") return formData[f.id] !== true;
      const v = formData[f.id];
      return v === undefined || v === null || v === "";
    });
    if (missing.length > 0) {
      toast.error(`Missing required fields: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }

    const offlineId = crypto.randomUUID();

    // Build the submitted data ONCE so the online path, the offline queue and the
    // local QR copy all store the identical shape. Previously the queued payload
    // omitted _matchPrefix/_matchNumber, so a row's shape depended on whether the
    // network happened to be up when the scout hit submit.
    const submittedData = {
      _matchPrefix: matchPrefix,
      _matchNumber: matchNumber,
      ...formData,
    };

    const payload = {
      templateId: template._id,
      eventKey: currentEvent.eventKey,
      matchNumber,
      compLevel: matchPrefix,
      teamNumber: primaryTeamNumber,
      data: JSON.stringify(submittedData),
    };

    // Always save locally so QR codes are available offline
    const localSub = {
      id: offlineId,
      matchNumber,
      teamNumber: primaryTeamNumber,
      templateId: template._id,
      templateName: template.name,
      eventKey: currentEvent.eventKey,
      compLevel: matchPrefix,
      data: submittedData as Record<string, unknown>,
      // Build a fieldId → label map so the QR viewer shows real names
      fieldLabels: {
        _matchPrefix: "Match Prefix",
        _matchNumber: "Match Number",
        ...Object.fromEntries(fields.map((f) => [f.id, f.label])),
      },
      submittedAt: Date.now(),
    };
    saveMySubmission(localSub);

    setSubmitting(true);
    try {
      if (!navigator.onLine) {
        enqueueOfflineSubmission({ ...payload, offlineId });
        refreshCounts();
        toast.success("Saved offline — will sync when connection returns.", { icon: "📶" });
      } else {
        await submitForm({
          templateId: template._id as Id<"formTemplates">,
          eventKey: currentEvent.eventKey,
          matchNumber,
          compLevel: matchPrefix,
          teamNumber: primaryTeamNumber,
          data: payload.data,
          offlineId,
        });
        // Tell the scout what they earned — the payout is the point of the
        // change, and a silent credit teaches nobody that scouting pays.
        const reward = (template as { coinReward?: number } | null)?.coinReward ?? 50;
        const what = isChecklist ? "Checklist done!" : isPitForm ? "Pit scouted!" : "Match scouted!";
        toast.success(reward > 0 ? `${what} +${reward} coins 🪙` : `${what} ✅`);
      }
      // Reset for next scout entry — bump match number, keep same form
      setFormData({});
      setMatchNumber((m) => m + 1);
      setMatchPrefix("qm");
    } catch {
      toast.error("Submission failed — saved offline instead.");
      enqueueOfflineSubmission({ ...payload, offlineId });
      refreshCounts();
    } finally {
      setSubmitting(false);
    }
  }

  // ── Loading / no cache yet ─────────────────────────────────────────────────
  // activeTemplates is undefined only when Convex hasn't responded AND there is
  // no cached value in localStorage (i.e. the form has never been loaded before).
  if (activeTemplates === undefined) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        {isOnline ? (
          <>
            <div className="h-7 w-7 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Loading forms…</p>
          </>
        ) : (
          <>
            <WifiOff className="h-8 w-8 text-amber-500 mb-1" />
            <p className="font-medium">You're offline</p>
            <p className="text-sm text-muted-foreground max-w-xs">
              No scouting form is cached yet. Connect once to load your form templates,
              then they'll be available offline.
            </p>
          </>
        )}
      </div>
    );
  }

  // ── No active forms ────────────────────────────────────────────────────────
  if (activeTemplates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <p className="text-muted-foreground">No active scouting form found.</p>
        <p className="text-sm text-muted-foreground">
          Go to <strong>Form Builder</strong> to create and activate a template.
        </p>
      </div>
    );
  }

  // ── Multiple forms — picker ────────────────────────────────────────────────
  if (activeTemplates.length > 1 && !selectedTemplate) {
    return (
      <FormPicker
        templates={activeTemplates as ActiveTemplate[]}
        onSelect={(t) => setSelectedTemplate(t)}
      />
    );
  }

  // ── Main scout form ────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight">
              {heading}
            </h2>
            {/* Back to picker button when multiple forms exist */}
            {activeTemplates.length > 1 && (
              <button
                onClick={() => setSelectedTemplate(null)}
                className="text-xs text-muted-foreground hover:text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-muted"
              >
                ← Change form
              </button>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {currentEvent?.eventName ?? "No event set"} · {template?.name}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {isOnline ? (
            <span className="flex items-center gap-1 text-green-500">
              <Wifi className="h-3.5 w-3.5" /> Online
            </span>
          ) : (
            <span className="flex items-center gap-1 text-yellow-500">
              <WifiOff className="h-3.5 w-3.5" /> Offline
            </span>
          )}
          {queueLength > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-500 font-mono">
              {queueLength} pending
            </span>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Match prefix + number — hidden for pit scouting forms */}
        {!isPitForm && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          {/* Match Prefix — checklists are quals-only, so there is nothing to pick */}
          {!isChecklist && (
          <div className="space-y-1.5">
            <Label>Match Prefix <span className="text-primary">*</span></Label>
            <div className="flex rounded-lg overflow-hidden border border-border w-fit">
              {(["qm", "elim"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setMatchPrefix(opt)}
                  className={`px-5 py-2 text-sm font-semibold transition-colors ${
                    matchPrefix === opt
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {opt === "qm" ? "Qual" : "Elim"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {matchPrefix === "qm" ? "Qualification match" : "Elimination match"}
            </p>
          </div>
          )}

          {/* Match Number */}
          <div className="space-y-1.5">
            <Label>Match Number <span className="text-primary">*</span></Label>
            <Input
              type="number"
              value={matchNumber}
              min={1}
              onChange={(e) => setMatchNumber(Number(e.target.value))}
              className="max-w-xs"
            />
          </div>
        </div>
        )}

        {/* Dynamic sections from form template */}
        {Object.entries(sections).map(([section, sectionFields]) => (
          <div key={section} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-primary/10 border-b border-border">
              <h3 className="font-semibold text-sm text-primary">{section}</h3>
            </div>
            <div className="p-4 space-y-4">
              {sectionFields.map((field) => (
                <div key={field.id} className="space-y-1.5">
                  {field.type !== "checkbox" && (
                    <Label>
                      {field.label}
                      {/* teamNumber fields are always required when present */}
                      {(field.required || field.type === "teamNumber") && (
                        <span className="text-primary ml-1">*</span>
                      )}
                    </Label>
                  )}
                  <FieldRenderer
                    field={field}
                    value={formData[field.id]}
                    onChange={(v) => setValue(field.id, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        <Separator />

        <Button
          type="submit"
          disabled={submitting}
          className="w-full h-12 text-base font-bold"
        >
          <Send className="h-4 w-4 mr-2" />
          {submitting ? "Submitting…" : submitLabel}
        </Button>
      </form>
    </div>
  );
}
