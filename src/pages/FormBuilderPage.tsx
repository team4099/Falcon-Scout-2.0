import { useState } from "react";
import { useUIStore } from "@/store/uiStore";
import { useQuery } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FormField, FieldType, FormType } from "@/types";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Plus,
  Trash2,
  GripVertical,
  Save,
  PenLine,
  Settings,
  Zap,
  CheckSquare,
  Type,
  Hash,
  List,
  AlignLeft,
  Users,
  Star,
  Lock,
  ShieldAlert,
  Zap as ActiveIcon,
  PowerOff,
  ClipboardList,
  Binoculars,
  Search,
  FolderPlus,
  Pencil,
  ChevronRight,
  Menu,
  X as XIcon,
  ClipboardCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ──────────────────────────────────────────────
// Field type metadata
// ──────────────────────────────────────────────

// All field types available in Default forms
const DEFAULT_FIELD_TYPES: Partial<Record<FieldType, { label: string; icon: React.ReactNode }>> = {
  text:       { label: "Short Text",  icon: <Type className="h-4 w-4" /> },
  textarea:   { label: "Long Text",   icon: <AlignLeft className="h-4 w-4" /> },
  number:     { label: "Number",      icon: <Hash className="h-4 w-4" /> },
  counter:    { label: "Counter",     icon: <Zap className="h-4 w-4" /> },
  checkbox:   { label: "Checkbox",    icon: <CheckSquare className="h-4 w-4" /> },
  select:     { label: "Dropdown",    icon: <List className="h-4 w-4" /> },
  teamNumber: { label: "Team Number", icon: <Users className="h-4 w-4" /> },
  rating:     { label: "Rating",      icon: <Star className="h-4 w-4" /> },
};

// Super scout forms: text + rating + team number
const SUPER_FIELD_TYPES: Partial<Record<FieldType, { label: string; icon: React.ReactNode }>> = {
  text:       { label: "Short Text",  icon: <Type className="h-4 w-4" /> },
  rating:     { label: "Rating",      icon: <Star className="h-4 w-4" /> },
  teamNumber: { label: "Team Number", icon: <Users className="h-4 w-4" /> },
};

// Pit scouting forms: all field types (same as default)
const PIT_FIELD_TYPES: Partial<Record<FieldType, { label: string; icon: React.ReactNode }>> = {
  ...DEFAULT_FIELD_TYPES,
};

// Checklist forms: all field types except teamNumber (not team-specific)
const CHECKLIST_FIELD_TYPES: Partial<Record<FieldType, { label: string; icon: React.ReactNode }>> = {
  text:     { label: "Short Text", icon: <Type className="h-4 w-4" /> },
  textarea: { label: "Long Text",  icon: <AlignLeft className="h-4 w-4" /> },
  number:   { label: "Number",     icon: <Hash className="h-4 w-4" /> },
  counter:  { label: "Counter",    icon: <Zap className="h-4 w-4" /> },
  checkbox: { label: "Checkbox",   icon: <CheckSquare className="h-4 w-4" /> },
  select:   { label: "Dropdown",   icon: <List className="h-4 w-4" /> },
  rating:   { label: "Rating",     icon: <Star className="h-4 w-4" /> },
};

// The pinned auto team-number field for Default forms
const AUTO_TEAM_FIELD: FormField = {
  id: "__auto_team__",
  type: "teamNumber",
  label: "Team Number",
  required: true,
};

function generateId() {
  return crypto.randomUUID().slice(0, 8);
}

function defaultField(type: FieldType, existing: FormField[]): FormField {
  const meta = DEFAULT_FIELD_TYPES[type] ?? SUPER_FIELD_TYPES[type];
  const base = `New ${meta?.label ?? type} field`;
  const existingLabels = new Set(existing.map((f) => f.label));
  let label = base;
  let n = 2;
  while (existingLabels.has(label)) label = `${base} ${n++}`;
  return {
    id: generateId(),
    type,
    label,
    required: false,
    options: type === "select" ? ["Option 1", "Option 2"] : type === "rating" ? ["5"] : undefined,
  };
}

// ──────────────────────────────────────────────
// Star rating preview (disabled)
// ──────────────────────────────────────────────
function StarPreview({ max = 5 }: { max?: number }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: max }).map((_, i) => (
        <Star key={i} className="h-6 w-6 text-muted-foreground/30" />
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────
// Sortable field wrapper
// ──────────────────────────────────────────────
function SortableField({
  field, onUpdate, onDelete, sections,
}: {
  field: FormField;
  onUpdate: (updated: FormField) => void;
  onDelete: () => void;
  sections: string[];
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id: field.id });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <>
      <div ref={setNodeRef} style={style} className="flex items-center gap-1.5">
        <button
          ref={setActivatorNodeRef} {...attributes} {...listeners}
          type="button"
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground p-1 touch-none"
          aria-label={`Drag to reorder ${field.label}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex-1">
          <FieldEditor field={field} onChange={onUpdate} onDelete={() => setConfirmDelete(true)} sections={sections} />
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete field?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="text-foreground">{field.label}</strong> will be permanently removed from this form. Any data already collected under this field will remain in submissions but won't be displayed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmDelete(false); onDelete(); }}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              Delete Field
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ──────────────────────────────────────────────
// Field Editor Dialog
// ──────────────────────────────────────────────
function FieldEditor({
  field, onChange, onDelete, sections,
}: {
  field: FormField;
  onChange: (updated: FormField) => void;
  onDelete: () => void;
  sections: string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FormField>(field);
  const allMeta = { ...DEFAULT_FIELD_TYPES };

  function save() { onChange(draft); setOpen(false); }

  const ratingMax = Number(draft.options?.[0] ?? "5");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 group bg-card border border-border rounded-lg px-3 py-2 hover:border-primary/50 transition-colors">
        <div className="text-muted-foreground shrink-0">
          {(allMeta[field.type] ?? SUPER_FIELD_TYPES[field.type])?.icon}
        </div>
        <span className="flex-1 text-sm font-medium truncate">{field.label}</span>
        {field.required && (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-primary/20 text-primary font-mono">req</span>
        )}
        <button onClick={() => setOpen(true)} className="p-1 rounded opacity-100 sm:opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-foreground">
          <Settings className="h-4 w-4" />
        </button>
        <Button variant="ghost" size="icon" className="h-7 w-7 opacity-100 sm:opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5 text-primary" /> Edit Field
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </div>

          <div className="space-y-1.5">
            <Label>Field Type</Label>
            <Select
              value={draft.type}
              onValueChange={(v) => setDraft({
                ...draft, type: v as FieldType,
                options: v === "select" ? ["Option 1"] : v === "rating" ? ["5"] : undefined,
              })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(allMeta) as FieldType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    <span className="flex items-center gap-2">{allMeta[t]?.icon}{allMeta[t]?.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Section — dropdown of existing sections */}
          <div className="space-y-1.5">
            <Label>Section</Label>
            <Select
              value={draft.section ?? sections[0] ?? "General"}
              onValueChange={(v) => setDraft({ ...draft, section: v ?? undefined })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {sections.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="required" checked={draft.required} onCheckedChange={(c) => setDraft({ ...draft, required: !!c })} />
            <Label htmlFor="required">Required field</Label>
          </div>

          {draft.type === "rating" && (
            <div className="space-y-2">
              <Label>Max Stars</Label>
              <Select
                value={String(ratingMax)}
                onValueChange={(v) => setDraft({ ...draft, options: [v ?? "5"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[3, 4, 5, 7, 10].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n} stars</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-1 pt-1">
                {Array.from({ length: ratingMax }).map((_, i) => (
                  <Star key={i} className="h-5 w-5 text-yellow-400 fill-yellow-400" />
                ))}
              </div>
            </div>
          )}

          {draft.type === "select" && (
            <div className="space-y-2">
              <Label>Options</Label>
              <div className="space-y-1.5">
                {(draft.options ?? []).map((opt, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={opt}
                      onChange={(e) => {
                        const opts = [...(draft.options ?? [])];
                        opts[i] = e.target.value;
                        setDraft({ ...draft, options: opts });
                      }}
                    />
                    <Button variant="ghost" size="icon" onClick={() => {
                      const opts = (draft.options ?? []).filter((_, j) => j !== i);
                      setDraft({ ...draft, options: opts });
                    }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="w-full" onClick={() =>
                  setDraft({ ...draft, options: [...(draft.options ?? []), `Option ${(draft.options?.length ?? 0) + 1}`] })
                }>
                  <Plus className="h-3 w-3 mr-1" /> Add option
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save}><Save className="h-4 w-4 mr-1" /> Save field</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────
// Section Block — groups fields under a named section header
// ──────────────────────────────────────────────
function SectionBlock({
  sectionName, fields, allSections, sensors, fieldTypeMeta, canDelete,
  onRename, onDelete, onUpdateField, onDeleteField, onAddField, onDragEnd,
}: {
  sectionName: string;
  fields: FormField[];
  allSections: string[];
  sensors: ReturnType<typeof useSensors>;
  fieldTypeMeta: typeof DEFAULT_FIELD_TYPES;
  canDelete: boolean;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onUpdateField: (field: FormField, updated: FormField) => void;
  onDeleteField: (field: FormField) => void;
  onAddField: (type: FieldType) => void;
  onDragEnd: (event: DragEndEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(sectionName);
  const [showAddField, setShowAddField] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function commitRename() {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== sectionName) onRename(trimmed);
    else setDraftName(sectionName);
    setEditing(false);
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-primary/5 border-b border-border">
        <ChevronRight className="h-3.5 w-3.5 text-primary shrink-0" />
        {editing ? (
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm font-semibold text-primary border-b border-primary outline-none"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setDraftName(sectionName); setEditing(false); } }}
          />
        ) : (
          <span className="flex-1 text-sm font-semibold text-primary">{sectionName}</span>
        )}
        <span className="text-xs text-muted-foreground font-mono">{fields.length} field{fields.length !== 1 ? "s" : ""}</span>
        <button
          onClick={() => setEditing(true)}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Rename section"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {canDelete && (
          <>
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Delete section (fields move to first remaining section)"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>

            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete section "{sectionName}"?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {fields.length > 0
                      ? `All ${fields.length} field${fields.length !== 1 ? "s" : ""} in this section will be moved to the first remaining section. The fields themselves won't be deleted.`
                      : "This empty section will be removed."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => { setConfirmDelete(false); onDelete(); }}
                    className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  >
                    Delete Section
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>

      {/* Fields within section */}
      <div className="p-2 space-y-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {fields.map((field) => (
              <SortableField
                key={field.id}
                field={field}
                onUpdate={(updated) => onUpdateField(field, updated)}
                onDelete={() => onDeleteField(field)}
                sections={allSections}
              />
            ))}
          </SortableContext>
        </DndContext>
        {fields.length === 0 && (
          <p className="text-xs text-muted-foreground/60 italic text-center py-3">
            No fields yet — add one below
          </p>
        )}
      </div>

      {/* Add field to this section */}
      <div className="px-3 pb-3 border-t border-border/50">
        <button
          onClick={() => setShowAddField((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-primary uppercase tracking-wider mt-2 mb-2 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Add field to "{sectionName}"
        </button>
        {showAddField && (
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(fieldTypeMeta) as FieldType[]).map((type) => (
              <Button
                key={type}
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs h-7"
                onClick={() => { onAddField(type); setShowAddField(false); }}
              >
                {fieldTypeMeta[type]?.icon}
                {fieldTypeMeta[type]?.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Add Section Button
// ──────────────────────────────────────────────
function AddSectionButton({ onAdd, existing }: { onAdd: (name: string) => void; existing: string[] }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  function commit() {
    const trimmed = name.trim();
    if (trimmed && !existing.includes(trimmed)) onAdd(trimmed);
    setName("");
    setAdding(false);
  }

  if (!adding) {
    return (
      <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="gap-2 w-full border-dashed">
        <FolderPlus className="h-4 w-4" /> Add Section
      </Button>
    );
  }

  return (
    <div className="flex gap-2 items-center border border-border rounded-lg p-2 bg-card">
      <FolderPlus className="h-4 w-4 text-muted-foreground shrink-0" />
      <input
        autoFocus
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Section name, e.g. Autonomous"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(""); setAdding(false); } }}
      />
      <Button size="sm" onClick={commit} disabled={!name.trim() || existing.includes(name.trim())}>Add</Button>
      <Button variant="ghost" size="sm" onClick={() => { setName(""); setAdding(false); }}>Cancel</Button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Form type badge
// ──────────────────────────────────────────────
function FormTypeBadge({ type }: { type: FormType }) {
  if (type === "super")
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-semibold">Super Scout</span>;
  if (type === "pit")
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 font-semibold">Pit Scout</span>;
  if (type === "checklist")
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 font-semibold">Checklist</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-semibold">Default</span>;
}

// ──────────────────────────────────────────────
// Main Form Builder Page
// ──────────────────────────────────────────────

/** Lock screen shown when admin mode is inactive */
function FormBuilderLocked() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-muted-foreground select-none">
      <div className="flex flex-col items-center gap-4 p-10 rounded-2xl border border-border bg-card max-w-sm w-full text-center shadow-sm">
        <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
          <ShieldAlert className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Admin Access Required</h2>
          <p className="text-sm text-muted-foreground">
            The Form Builder is restricted to admins. Enable admin mode in Settings to continue.
          </p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-muted/50 border border-border/50 text-sm text-muted-foreground w-full justify-center">
          <Lock className="h-4 w-4 shrink-0" />
          <span>Go to <strong className="text-foreground">Settings → Admin Mode</strong></span>
        </div>
      </div>
    </div>
  );
}

export default function FormBuilderPage() {
  const { isAdminMode } = useUIStore();
  if (!isAdminMode) return <FormBuilderLocked />;
  return <FormBuilderContent />;
}

/** The actual builder — rendered only when admin mode is active */
function FormBuilderContent() {
  const templates = useQuery(api.forms.listTemplates);
  const createTemplate = useAdminMutation(api.forms.createTemplate);
  const updateTemplate = useAdminMutation(api.forms.updateTemplate);
  const deleteTemplate = useAdminMutation(api.forms.deleteTemplate);
  const activateTemplate = useAdminMutation(api.forms.activateTemplate);
  const deactivateTemplate = useAdminMutation(api.forms.deactivateTemplate);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("New Scouting Form");
  const [description, setDescription] = useState("");
  const [formType, setFormType] = useState<FormType>("default");
  const [fields, setFields] = useState<FormField[]>([]);
  const [sectionNames, setSectionNames] = useState<string[]>(["General"]);
  const [saving, setSaving] = useState(false);
  const [confirmFormDelete, setConfirmFormDelete] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Identify currently active forms by type
  const activeDefault   = templates?.find((t) => t.isActive && (t.formType ?? "default") === "default");
  const activeSuper     = templates?.find((t) => t.isActive && (t.formType ?? "default") === "super");
  const activePit       = templates?.find((t) => t.isActive && (t.formType ?? "default") === "pit");
  const activeChecklists = templates?.filter((t) => t.isActive && t.formType === "checklist") ?? [];

  function loadTemplate(t: NonNullable<typeof templates>[number]) {
    setSelectedId(t._id);
    setName(t.name);
    setDescription(t.description ?? "");
    setFormType((t.formType as FormType) ?? "default");
    // Strip the auto team field from stored fields — it's always shown as pinned
    const userFields = (t.fields as FormField[]).filter((f) => f.id !== AUTO_TEAM_FIELD.id);
    setFields(userFields);
    // Rebuild ordered section list from the fields
    const seen = new Set<string>();
    const orderedSections: string[] = [];
    for (const f of userFields) {
      const s = f.section ?? "General";
      if (!seen.has(s)) { seen.add(s); orderedSections.push(s); }
    }
    setSectionNames(orderedSections.length > 0 ? orderedSections : ["General"]);
  }

  /** Returns a name that doesn't already exist among other templates.
   *  If `name` is taken (by any template other than `excludeId`),
   *  it tries "name (2)", "name (3)", … until finding a free slot. */
  function uniqueName(name: string, excludeId?: string | null): string {
    const taken = new Set(
      (templates ?? [])
        .filter(t => t._id !== excludeId)
        .map(t => t.name)
    );
    if (!taken.has(name)) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
  }

  function newForm() {
    setSelectedId(null);
    setName(uniqueName("New Scouting Form"));
    setDescription("");
    setFormType("default");
    setFields([]);
    setSectionNames(["General"]);
  }

  async function saveTemplate() {
    setSaving(true);
    try {
      // Default and pit forms both get the pinned team# field prepended
      const savedFields = (formType === "default" || formType === "pit")
        ? [AUTO_TEAM_FIELD, ...fields]
        : fields;

      if (selectedId) {
        // Deduplicate name against all other templates (excluding self)
        const safeName = uniqueName(name, selectedId);
        if (safeName !== name) setName(safeName);
        await updateTemplate({
          id: selectedId as Id<"formTemplates">,
          name: safeName, description: description || undefined,
          formType,
          fields: savedFields,
        });
        toast.success("Form saved!");
      } else {
        const safeName = uniqueName(name);
        if (safeName !== name) setName(safeName);
        const newId = await createTemplate({
          name: safeName, description: description || undefined,
          formType,
          fields: savedFields,
          isActive: false,
        });
        setSelectedId(newId as string);
        toast.success("Form created!");
      }
    } catch {
      toast.error("Failed to save form.");
    } finally {
      setSaving(false);
    }
  }

  const currentlyActive = selectedId
    ? templates?.find((t) => t._id === selectedId)?.isActive ?? false
    : false;

  async function handleActivate() {
    if (!selectedId) return;
    await saveTemplate();
    try {
      await activateTemplate({ id: selectedId as Id<"formTemplates"> });
      const label = formType === "default" ? "Default" : formType === "super" ? "Super Scout" : formType === "pit" ? "Pit Scout" : "Checklist";
      toast.success(`Activated as ${label} form!`);
    } catch {
      toast.error("Failed to activate.");
    }
  }

  async function handleDeactivate() {
    if (!selectedId) return;
    try {
      await deactivateTemplate({ id: selectedId as Id<"formTemplates"> });
      toast.success("Form deactivated.");
    } catch {
      toast.error("Failed to deactivate.");
    }
  }

  // ── Section management ─────────────────────────────────────────────────────
  function addSection(name: string) {
    if (!sectionNames.includes(name)) setSectionNames((p) => [...p, name]);
  }

  function renameSection(oldName: string, newName: string) {
    if (!newName.trim() || sectionNames.includes(newName)) return;
    setSectionNames((p) => p.map((s) => (s === oldName ? newName : s)));
    setFields((p) => p.map((f) => f.section === oldName ? { ...f, section: newName } : f));
  }

  function deleteSection(name: string) {
    const remaining = sectionNames.filter((s) => s !== name);
    const fallback = remaining[0] ?? "General";
    setSectionNames(remaining.length > 0 ? remaining : ["General"]);
    setFields((p) => p.map((f) => (f.section === name ? { ...f, section: fallback } : f)));
  }

  function addField(type: FieldType, section?: string) {
    const newField = defaultField(type, fields);
    newField.section = section ?? sectionNames[0] ?? "General";
    setFields((prev) => [...prev, newField]);
  }

  function updateField(field: FormField, updated: FormField) {
    // If section changed, ensure the new section exists in sectionNames
    if (updated.section && !sectionNames.includes(updated.section)) {
      setSectionNames((p) => [...p, updated.section!]);
    }
    setFields((prev) => prev.map((f) => (f.id === field.id ? updated : f)));
  }

  function deleteField(field: FormField) {
    setFields((prev) => prev.filter((f) => f.id !== field.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setFields((prev) => {
        const oldIndex = prev.findIndex((f) => f.id === active.id);
        const newIndex = prev.findIndex((f) => f.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }

  const fieldTypeMeta = formType === "super" ? SUPER_FIELD_TYPES : formType === "pit" ? PIT_FIELD_TYPES : formType === "checklist" ? CHECKLIST_FIELD_TYPES : DEFAULT_FIELD_TYPES;

  // Group fields by section for preview
  const previewFields = (formType === "default" || formType === "pit") ? [AUTO_TEAM_FIELD, ...fields] : fields;
  const previewSections = previewFields.reduce<Record<string, FormField[]>>((acc, f) => {
    const key = f.section ?? "General";
    acc[key] = [...(acc[key] ?? []), f];
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-0">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Form Builder</h2>
          <p className="text-muted-foreground text-sm">Design and manage your scouting forms</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Mobile sidebar toggle */}
          <Button
            variant="outline"
            size="icon"
            className="sm:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Show forms list"
          >
            <Menu className="h-4 w-4" />
          </Button>
          <Button onClick={newForm} variant="outline" size="sm">
            <Plus className="h-4 w-4 mr-1" /> New Form
          </Button>
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-50 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="absolute left-0 top-0 bottom-0 w-72 bg-background border-r border-border flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Forms</p>
              <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(false)}>
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
              {/* Active form indicators */}
              {(activeDefault || activeSuper || activePit) && (
                <div className="mb-2 space-y-1">
                  {activeDefault && (
                    <div className="flex items-center gap-1.5 text-xs text-primary px-2 py-1 rounded-md bg-primary/10">
                      <ClipboardList className="h-3 w-3" />
                      <span className="truncate font-medium">{activeDefault.name}</span>
                    </div>
                  )}
                  {activeSuper && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-400 px-2 py-1 rounded-md bg-amber-500/10">
                      <Binoculars className="h-3 w-3" />
                      <span className="truncate font-medium">{activeSuper.name}</span>
                    </div>
                  )}
                  {activePit && (
                    <div className="flex items-center gap-1.5 text-xs text-cyan-400 px-2 py-1 rounded-md bg-cyan-500/10">
                      <Search className="h-3 w-3" />
                      <span className="truncate font-medium">{activePit.name}</span>
                    </div>
                  )}
                  {activeChecklists.map((cl) => (
                    <div key={cl._id} className="flex items-center gap-1.5 text-xs text-violet-400 px-2 py-1 rounded-md bg-violet-500/10">
                      <ClipboardCheck className="h-3 w-3" />
                      <span className="truncate font-medium">{cl.name}</span>
                    </div>
                  ))}
                </div>
              )}
              {templates === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
              {templates?.map((t) => {
                const tType: FormType = (t.formType as FormType) ?? "default";
                return (
                  <button
                    key={t._id}
                    onClick={() => { loadTemplate(t); setSidebarOpen(false); }}
                    className={`text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                      selectedId === t._id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-card border-border hover:border-primary/50"
                    }`}
                  >
                    <p className="font-medium truncate">{t.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <FormTypeBadge type={tType} />
                      {t.isActive && <span className="text-[10px] text-green-400 font-semibold">● active</span>}
                    </div>
                  </button>
                );
              })}
              {templates?.length === 0 && <p className="text-xs text-muted-foreground italic">No forms yet.</p>}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-6 items-start">
        {/* Sidebar: form list — hidden on mobile (use menu button instead) */}
        <div className="hidden sm:flex w-56 shrink-0 flex-col gap-2 overflow-y-auto sticky top-0 max-h-[calc(100vh-10rem)]">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Forms</p>

          {/* Active form indicators */}
          {(activeDefault || activeSuper || activePit || activeChecklists.length > 0) && (
            <div className="mb-2 space-y-1">
              {activeDefault && (
                <div className="flex items-center gap-1.5 text-xs text-primary px-2 py-1 rounded-md bg-primary/10">
                  <ClipboardList className="h-3 w-3" />
                  <span className="truncate font-medium">{activeDefault.name}</span>
                </div>
              )}
              {activeSuper && (
                <div className="flex items-center gap-1.5 text-xs text-amber-400 px-2 py-1 rounded-md bg-amber-500/10">
                  <Binoculars className="h-3 w-3" />
                  <span className="truncate font-medium">{activeSuper.name}</span>
                </div>
              )}
              {activePit && (
                <div className="flex items-center gap-1.5 text-xs text-cyan-400 px-2 py-1 rounded-md bg-cyan-500/10">
                  <Search className="h-3 w-3" />
                  <span className="truncate font-medium">{activePit.name}</span>
                </div>
              )}
              {activeChecklists.map((cl) => (
                <div key={cl._id} className="flex items-center gap-1.5 text-xs text-violet-400 px-2 py-1 rounded-md bg-violet-500/10">
                  <ClipboardCheck className="h-3 w-3" />
                  <span className="truncate font-medium">{cl.name}</span>
                </div>
              ))}
            </div>
          )}

          {templates === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
          {templates?.map((t) => {
            const tType: FormType = (t.formType as FormType) ?? "default";
            return (
              <button
                key={t._id}
                onClick={() => loadTemplate(t)}
                className={`text-left px-3 py-2 rounded-lg text-sm transition-colors border ${
                  selectedId === t._id
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border hover:border-primary/50"
                }`}
              >
                <p className="font-medium truncate">{t.name}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <FormTypeBadge type={tType} />
                  {t.isActive && <span className="text-[10px] text-green-400 font-semibold">● active</span>}
                </div>
              </button>
            );
          })}
          {templates?.length === 0 && <p className="text-xs text-muted-foreground italic">No forms yet.</p>}
        </div>

        {/* Main editor */}
        <div className="flex-1 min-w-0">
          <Tabs defaultValue="edit">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
              <TabsList className="shrink-0 self-start">
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="preview">Preview</TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2 flex-wrap sm:ml-auto">
                {/* Activate / Deactivate */}
                {selectedId && (
                  currentlyActive ? (
                    <Button onClick={handleDeactivate} variant="outline" size="sm" className="text-muted-foreground">
                      <PowerOff className="h-4 w-4 mr-1" /> Deactivate
                    </Button>
                  ) : (
                    <Button onClick={handleActivate} size="sm" variant="outline" className="border-green-500/50 text-green-400 hover:bg-green-500/10">
                      <ActiveIcon className="h-4 w-4 mr-1" />
                      Activate as {formType === "default" ? "Default" : formType === "super" ? "Super Scout" : formType === "pit" ? "Pit Scout" : "Checklist"}
                    </Button>
                  )
                )}
                <Button onClick={saveTemplate} disabled={saving} size="sm">
                  <Save className="h-4 w-4 mr-1" />
                  {saving ? "Saving…" : selectedId ? "Save Form" : "Create Form"}
                </Button>
                {selectedId && (
                  <>
                    <Button
                      variant="ghost" size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmFormDelete(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>

                    <AlertDialog open={confirmFormDelete} onOpenChange={setConfirmFormDelete}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this form?</AlertDialogTitle>
                          <AlertDialogDescription>
                            <strong className="text-foreground">{name || "This form"}</strong> will be permanently deleted. All {fields.length} field{fields.length !== 1 ? "s" : ""} will be lost. Existing submissions that reference this form will still be stored but won't be viewable.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                            onClick={async () => {
                              setConfirmFormDelete(false);
                              await deleteTemplate({ id: selectedId as Id<"formTemplates"> });
                              toast.success("Form deleted.");
                              newForm();
                            }}
                          >
                            Delete Form
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}
              </div>
            </div>

            <TabsContent value="edit" className="space-y-4">
              {/* Form meta */}
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                {/* Form type selector */}
                <div className="space-y-1.5">
                  <Label>Form Type</Label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      onClick={() => { setFormType("default"); setFields((prev) => prev); }}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "default"
                          ? "border-primary bg-primary/10 text-primary font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <ClipboardList className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Default</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Match scouting</p>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setFormType("super");
                        // Remove incompatible fields when switching to super
                        setFields((prev) => prev.filter((f) => f.type === "text" || f.type === "rating"));
                      }}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "super"
                          ? "border-amber-500 bg-amber-500/10 text-amber-400 font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Binoculars className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Super Scout</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Text + ratings</p>
                      </div>
                    </button>
                    <button
                      onClick={() => { setFormType("pit"); setFields((prev) => prev); }}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "pit"
                          ? "border-cyan-500 bg-cyan-500/10 text-cyan-400 font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Search className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Pit Scout</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Per-team, no match#</p>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setFormType("checklist");
                        // Remove teamNumber fields — not applicable for checklists
                        setFields((prev) => prev.filter((f) => f.type !== "teamNumber"));
                      }}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "checklist"
                          ? "border-violet-500 bg-violet-500/10 text-violet-400 font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <ClipboardCheck className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Checklist</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Pit duty tasks</p>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Form Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2025 Regional Scouting Form" />
                </div>
                <div className="space-y-1.5">
                  <Label>Description (optional)</Label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes about this form…" rows={2} />
                </div>
              </div>

              {/* Pinned auto team# field for default and pit forms */}
              {(formType === "default" || formType === "pit") && (
                <div className="flex items-center gap-1.5">
                  <div className="p-1 text-muted-foreground/40">
                    <Lock className="h-4 w-4" />
                  </div>
                  <div className="flex-1 flex items-center gap-2 bg-card border border-border/50 border-dashed rounded-lg px-3 py-2 opacity-70">
                    <Users className="h-4 w-4 text-primary shrink-0" />
                    <span className="text-sm font-medium">Team Number</span>
                    <span className="text-xs px-1.5 py-0.5 rounded-sm bg-primary/20 text-primary font-mono ml-1">req</span>
                    <span className="ml-auto text-xs text-muted-foreground italic">auto · pinned</span>
                  </div>
                </div>
              )}
              {formType === "checklist" && (
                <div className="flex items-center gap-1.5">
                  <div className="p-1 text-muted-foreground/40">
                    <Lock className="h-4 w-4" />
                  </div>
                  <div className="flex-1 flex items-center gap-2 bg-violet-500/5 border border-violet-500/20 border-dashed rounded-lg px-3 py-2 opacity-80">
                    <ClipboardCheck className="h-4 w-4 text-violet-400 shrink-0" />
                    <span className="text-sm font-medium text-violet-400">Pit Scout Checklist</span>
                    <span className="ml-auto text-xs text-muted-foreground italic">assigned by match · no team#</span>
                  </div>
                </div>
              )}

              {/* Section-grouped field canvas */}
              <div className="space-y-3">
                {sectionNames.map((sec) => {
                  const secFields = fields.filter((f) => (f.section ?? sectionNames[0]) === sec);
                  return (
                    <SectionBlock
                      key={sec}
                      sectionName={sec}
                      fields={secFields}
                      allSections={sectionNames}
                      sensors={sensors}
                      fieldTypeMeta={fieldTypeMeta}
                      canDelete={sectionNames.length > 1}
                      onRename={(newName) => renameSection(sec, newName)}
                      onDelete={() => deleteSection(sec)}
                      onUpdateField={updateField}
                      onDeleteField={deleteField}
                      onAddField={(type) => addField(type, sec)}
                      onDragEnd={handleDragEnd}
                    />
                  );
                })}
                <AddSectionButton onAdd={addSection} existing={sectionNames} />
              </div>
            </TabsContent>

            <TabsContent value="preview">
              <div className="bg-card border border-border rounded-xl p-6 space-y-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-xl font-bold">{name || "Untitled Form"}</h3>
                    {description && <p className="text-muted-foreground text-sm mt-1">{description}</p>}
                  </div>
                  <FormTypeBadge type={formType} />
                </div>

                {Object.entries(previewSections).map(([section, sectionFields]) => (
                  <div key={section} className="space-y-3">
                    <p className="font-semibold text-primary border-b border-border pb-1">{section}</p>
                    {sectionFields.map((f) => (
                      <div key={f.id} className="space-y-1.5">
                        <Label>
                          {f.label}
                          {f.required && <span className="text-primary ml-1">*</span>}
                          {f.id === AUTO_TEAM_FIELD.id && <span className="text-xs text-muted-foreground ml-2 italic">auto</span>}
                        </Label>
                        {f.type === "teamNumber" && <Input type="number" placeholder="e.g. 4099" disabled />}
                        {f.type === "text" && <Input placeholder={f.label} disabled />}
                        {f.type === "textarea" && <Textarea placeholder={f.label} disabled rows={2} />}
                        {f.type === "number" && <Input type="number" placeholder="0" disabled />}
                        {f.type === "counter" && (
                          <div className="flex items-center gap-2">
                            <Button variant="outline" size="icon" disabled>−</Button>
                            <span className="w-10 text-center font-mono">0</span>
                            <Button variant="outline" size="icon" disabled>+</Button>
                          </div>
                        )}
                        {f.type === "checkbox" && (
                          <div className="flex items-center gap-2">
                            <Checkbox disabled />
                            <Label className="font-normal">{f.label}</Label>
                          </div>
                        )}
                        {f.type === "rating" && <StarPreview max={Number(f.options?.[0] ?? "5")} />}
                        {f.type === "select" && (
                          <Select disabled>
                            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                            <SelectContent>
                              {(f.options ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
                {previewFields.length === 0 && <p className="text-muted-foreground text-sm italic">Add fields to see the preview.</p>}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
