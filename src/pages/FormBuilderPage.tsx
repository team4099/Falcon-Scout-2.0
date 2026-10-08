import { useState } from "react";
import { useUIStore } from "@/store/uiStore";
import { useQuery } from "convex/react";
import { useAdminMutation } from "@/hooks/useAdminMutation";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatKey } from "../../convex/formFormat";
import type { FormField, FieldType, FormType } from "@/types";
import { FORM_TYPE_LABEL, hasChoiceOptions, sortForms } from "@/types";
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
  Camera,
  CircleDot,
  Eye,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { moveFieldToSection, moveSection, orderFieldsBySection, sectionOf } from "@/lib/formSections";

// Droppable id prefix for a section's field list (lets fields drop into empty sections).
const SECTION_DROP = "section::";

// ──────────────────────────────────────────────
// Field type metadata
// ──────────────────────────────────────────────

// Every form type offers every field type.
const FIELD_TYPES: Partial<Record<FieldType, { label: string; icon: React.ReactNode }>> = {
  text:       { label: "Short Text",      icon: <Type className="h-4 w-4" /> },
  textarea:   { label: "Long Text",       icon: <AlignLeft className="h-4 w-4" /> },
  number:     { label: "Number",          icon: <Hash className="h-4 w-4" /> },
  counter:    { label: "Counter",         icon: <Zap className="h-4 w-4" /> },
  checkbox:   { label: "Checkbox",        icon: <CheckSquare className="h-4 w-4" /> },
  select:     { label: "Dropdown",        icon: <List className="h-4 w-4" /> },
  radio:      { label: "Multiple Choice", icon: <CircleDot className="h-4 w-4" /> },
  teamNumber: { label: "Team Number",     icon: <Users className="h-4 w-4" /> },
  rating:     { label: "Rating",          icon: <Star className="h-4 w-4" /> },
  photo:      { label: "Photo",           icon: <Camera className="h-4 w-4" /> },
};

/** Starting options when a field becomes `type`, keeping any answers it
 *  already had when switching between dropdown and multiple choice. */
function initialOptions(type: FieldType, prev?: string[]): string[] | undefined {
  if (hasChoiceOptions(type)) return prev?.length ? prev : ["Option 1", "Option 2"];
  if (type === "rating") return ["5"];
  return undefined;
}

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
  const meta = FIELD_TYPES[type];
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
    options: initialOptions(type),
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
  const allMeta = FIELD_TYPES;

  // Re-seed the draft from the live field on every open: a cancelled edit
  // must not linger, and a section rename/drag since mount must not be
  // reverted by saving a stale copy.
  function openEditor() { setDraft(field); setOpen(true); }

  function save() {
    const options = hasChoiceOptions(draft.type)
      ? [...new Set((draft.options ?? []).map((o) => o.trim()).filter(Boolean))]
      : draft.options;
    onChange({ ...draft, label: draft.label.trim() || field.label, options });
    setOpen(false);
  }

  const ratingMax = Number(draft.options?.[0] ?? "5");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 group bg-card border border-border rounded-lg px-3 py-2 hover:border-primary/50 transition-colors">
        <div className="text-muted-foreground shrink-0">
          {allMeta[field.type]?.icon}
        </div>
        <span className="flex-1 text-sm font-medium truncate">{field.label}</span>
        {field.required && (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-primary/20 text-primary font-mono">req</span>
        )}
        {field.showInRankings && (
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono" title="Available as a Dashboard rankings column">col</span>
        )}
        <button onClick={openEditor} className="p-1 rounded opacity-100 sm:opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-foreground">
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
            <Label>{draft.type === "radio" ? "Question / prompt" : "Label"}</Label>
            <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </div>

          <div className="space-y-1.5">
            <Label>Field Type</Label>
            <Select
              value={draft.type}
              onValueChange={(v) => setDraft({
                ...draft, type: v as FieldType,
                options: initialOptions(v as FieldType, hasChoiceOptions(draft.type) ? draft.options : undefined),
              })}
            >
              <SelectTrigger>
                <SelectValue>{(v: string | null) => (v ? allMeta[v as FieldType]?.label ?? v : "")}</SelectValue>
              </SelectTrigger>
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

          {/* Photos and team numbers don't aggregate into a meaningful column. */}
          {draft.type !== "photo" && draft.type !== "teamNumber" && (
            <div className="flex items-start gap-2">
              <Checkbox
                id="showInRankings"
                checked={!!draft.showInRankings}
                onCheckedChange={(c) => setDraft({ ...draft, showInRankings: c ? true : undefined })}
              />
              <div className="space-y-0.5">
                <Label htmlFor="showInRankings">Rankings column</Label>
                <p className="text-xs text-muted-foreground">
                  Adds this field to the Dashboard's column picker (hidden until someone turns it on).
                </p>
              </div>
            </div>
          )}

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

          {hasChoiceOptions(draft.type) && (
            <div className="space-y-2">
              <Label>{draft.type === "radio" ? "Answers" : "Options"}</Label>
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
                  <Plus className="h-3 w-3 mr-1" /> {draft.type === "radio" ? "Add answer" : "Add option"}
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
  sectionName, fields, allSections, fieldTypeMeta, canDelete,
  onRename, onDelete, onUpdateField, onDeleteField, onAddField, onMoveUp, onMoveDown,
}: {
  sectionName: string;
  fields: FormField[];
  allSections: string[];
  fieldTypeMeta: typeof FIELD_TYPES;
  canDelete: boolean;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onUpdateField: (field: FormField, updated: FormField) => void;
  onDeleteField: (field: FormField) => void;
  onAddField: (type: FieldType) => void;
  /** Undefined when the section is already first/last. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: SECTION_DROP + sectionName });
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
          onClick={onMoveUp}
          disabled={!onMoveUp}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Move section up"
          aria-label={`Move section ${sectionName} up`}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onMoveDown}
          disabled={!onMoveDown}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Move section down"
          aria-label={`Move section ${sectionName} down`}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
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
      <div ref={setDropRef} className={`p-2 space-y-2 transition-colors ${isOver ? "bg-primary/5" : ""}`}>
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
        {fields.length === 0 && (
          <p className="text-xs text-muted-foreground/60 italic text-center py-3">
            No fields yet — add one or drag one here
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
  const cls =
    type === "super" ? "bg-amber-500/20 text-amber-400"
    : type === "pit" ? "bg-cyan-500/20 text-cyan-400"
    : type === "spy" ? "bg-violet-500/20 text-violet-400"
    : "bg-primary/20 text-primary";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>{FORM_TYPE_LABEL[type] ?? "Default"}</span>;
}

// ──────────────────────────────────────────────
// Sidebar form row — drag the grip to reorder
// ──────────────────────────────────────────────
function SortableFormItem({
  id, name, type, isActive, selected, onPick,
}: {
  id: string;
  name: string;
  type: FormType;
  isActive: boolean;
  selected: boolean;
  onPick: () => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 50 : undefined }}
      className={`flex items-stretch rounded-lg text-sm border ${
        selected
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card border-border hover:border-primary/50"
      }`}
    >
      <button
        ref={setActivatorNodeRef} {...attributes} {...listeners}
        type="button"
        className="px-2.5 sm:px-1.5 cursor-grab active:cursor-grabbing opacity-60 hover:opacity-100 touch-none"
        aria-label={`Drag to reorder ${name}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={onPick} className="flex-1 min-w-0 text-left pr-3 py-2">
        <p className="font-medium truncate">{name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <FormTypeBadge type={type} />
          {isActive && <span className={`text-[10px] font-semibold ${selected ? "text-green-900" : "text-green-400"}`}>● active</span>}
        </div>
      </button>
    </div>
  );
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
  const reorderTemplates = useAdminMutation(api.forms.reorderTemplates);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("New Scouting Form");
  const [description, setDescription] = useState("");
  const [formType, setFormType] = useState<FormType>("default");
  const hasPinnedTeam = formType !== "spy";
  // Coins paid per accepted submission of this form.
  const [coinReward, setCoinReward] = useState<number>(50);
  const [fields, setFields] = useState<FormField[]>([]);
  const [sectionNames, setSectionNames] = useState<string[]>(["General"]);
  const [saving, setSaving] = useState(false);
  const [confirmFormDelete, setConfirmFormDelete] = useState(false);
  // Earlier events always keep the form they were scouted with. The current
  // event is the one case the server can't decide alone, so a save that would
  // restyle its reports asks first (see forms.updateTemplate).
  const currentEventInUse = useQuery(
    api.forms.currentEventReports,
    selectedId ? { id: selectedId as Id<"formTemplates"> } : "skip",
  );
  const [askCurrentEvent, setAskCurrentEvent] = useState<{ eventName: string; activate: boolean } | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const listSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // A just-dropped order, shown until the server's copy catches up.
  const [droppedOrder, setDroppedOrder] = useState<string[] | null>(null);
  const orderedTemplates = templates && sortForms(
    droppedOrder
      ? templates.map((t) => ({ ...t, sortOrder: droppedOrder.indexOf(t._id) === -1 ? undefined : droppedOrder.indexOf(t._id) }))
      : templates,
  );

  async function handleReorder({ active, over }: DragEndEvent) {
    if (!orderedTemplates || !over || active.id === over.id) return;
    const ids = orderedTemplates.map((t) => t._id);
    const moved = arrayMove(ids, ids.indexOf(active.id as Id<"formTemplates">), ids.indexOf(over.id as Id<"formTemplates">));
    setDroppedOrder(moved);
    try {
      await reorderTemplates({ ids: moved });
    } catch {
      toast.error("Failed to save the new order.");
    } finally {
      setDroppedOrder(null);
    }
  }

  function loadTemplate(t: NonNullable<typeof templates>[number]) {
    setSelectedId(t._id);
    setName(t.name);
    setDescription(t.description ?? "");
    setFormType((t.formType as FormType) ?? "default");
    setCoinReward((t as { coinReward?: number }).coinReward ?? 50);
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

  function renderFormList(onPick: () => void) {
    return (
      <>
        {templates === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
        <DndContext sensors={listSensors} collisionDetection={closestCorners} onDragEnd={handleReorder}>
          <SortableContext items={orderedTemplates?.map((t) => t._id) ?? []} strategy={verticalListSortingStrategy}>
            {orderedTemplates?.map((t) => (
              <SortableFormItem
                key={t._id}
                id={t._id}
                name={t.name}
                type={(t.formType as FormType) ?? "default"}
                isActive={t.isActive}
                selected={selectedId === t._id}
                onPick={() => { loadTemplate(t); onPick(); }}
              />
            ))}
          </SortableContext>
        </DndContext>
        {/* The form being drafted, until Create Form saves it */}
        {!selectedId && (
          <div className="px-3 py-2 rounded-lg text-sm border border-dashed border-primary bg-primary/10">
            <p className="font-medium truncate">{name || "Untitled Form"}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <FormTypeBadge type={formType} />
              <span className="text-[10px] font-semibold text-muted-foreground">not saved yet</span>
            </div>
          </div>
        )}
      </>
    );
  }

  function newForm() {
    setSelectedId(null);
    setName(uniqueName("New Scouting Form"));
    setDescription("");
    setFormType("default");
    setFields([]);
    setSectionNames(["General"]);
  }

  // Every form but spying gets the pinned team# field prepended
  // Sections render in first-appearance order, so persist fields grouped
  // by the builder's section order.
  function fieldsToSave(): FormField[] {
    const ordered = orderFieldsBySection(fields, sectionNames);
    return hasPinnedTeam ? [AUTO_TEAM_FIELD, ...ordered] : ordered;
  }

  /** Save (and optionally activate), asking first when the current event's
   *  already-filed reports would change format. */
  function requestSave(activate: boolean) {
    const saved = templates?.find((t) => t._id === selectedId);
    const draft = { name: name.trim() || "Untitled Form", formType, fields: fieldsToSave() };
    if (saved && currentEventInUse && formatKey(draft) !== formatKey(saved)) {
      setAskCurrentEvent({ eventName: currentEventInUse.eventName, activate });
    } else {
      void (activate ? handleActivate() : saveTemplate());
    }
  }

  async function saveTemplate(keepCurrentEvent?: boolean) {
    setSaving(true);
    try {
      const savedFields = fieldsToSave();

      if (selectedId) {
        // Deduplicate name against all other templates (excluding self)
        const safeName = uniqueName(name.trim() || "Untitled Form", selectedId);
        if (safeName !== name) setName(safeName);
        const saved = await updateTemplate({
          id: selectedId as Id<"formTemplates">,
          // Send "" rather than undefined so a cleared description is removed
          // server-side (undefined args are dropped and would be a no-op).
          name: safeName, description,
          formType,
          fields: savedFields,
          coinReward,
          ...(keepCurrentEvent ? { keepCurrentEvent: true } : {}),
        });
        // Only one form per type is active (enforced in forms.updateTemplate).
        if (currentlyActive && saved?.isActive === false) {
          toast.info(`Form saved, and deactivated: another ${FORM_TYPE_LABEL[formType]} form is already active.`);
        } else {
          toast.success("Form saved!");
        }
      } else {
        const safeName = uniqueName(name.trim() || "Untitled Form");
        if (safeName !== name) setName(safeName);
        const newId = await createTemplate({
          name: safeName, description: description.trim() || undefined,
          formType,
          fields: savedFields,
          coinReward,
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

  async function handleActivate(keepCurrentEvent?: boolean) {
    if (!selectedId) return;
    await saveTemplate(keepCurrentEvent);
    try {
      const replaced = (await activateTemplate({ id: selectedId as Id<"formTemplates"> }))?.deactivated ?? [];
      toast.success(
        `Activated as ${FORM_TYPE_LABEL[formType]} form!` +
        (replaced.length ? ` ${replaced.join(", ")} was deactivated.` : ""),
      );
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

  // Where a drag is pointing: a field (drop at its slot) or a section's list (append).
  function dropTarget(overId: string): { section: string; fieldId: string | null } | null {
    if (overId.startsWith(SECTION_DROP)) return { section: overId.slice(SECTION_DROP.length), fieldId: null };
    const f = fields.find((x) => x.id === overId);
    return f ? { section: sectionOf(f, sectionNames), fieldId: f.id } : null;
  }

  // Crossing into another section re-homes the field live, so the target
  // list opens a gap for it while dragging.
  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const dragged = fields.find((f) => f.id === active.id);
    const target = dropTarget(String(over.id));
    if (!dragged || !target || sectionOf(dragged, sectionNames) === target.section) return;
    setFields((prev) => moveFieldToSection(prev, sectionNames, String(active.id), target.section, target.fieldId));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id && !String(over.id).startsWith(SECTION_DROP)) {
      setFields((prev) => {
        const oldIndex = prev.findIndex((f) => f.id === active.id);
        const newIndex = prev.findIndex((f) => f.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }

  // Group fields by section for preview
  const orderedFields = orderFieldsBySection(fields, sectionNames);
  const previewFields = hasPinnedTeam ? [AUTO_TEAM_FIELD, ...orderedFields] : orderedFields;
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
              {renderFormList(() => setSidebarOpen(false))}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-6 items-start">
        {/* Sidebar: form list — hidden on mobile (use menu button instead) */}
        <div className="hidden sm:flex w-56 shrink-0 flex-col gap-2 overflow-y-auto sticky top-0 max-h-[calc(100vh-10rem)]">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Forms</p>
          {renderFormList(() => {})}
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
                    <Button onClick={() => requestSave(true)} size="sm" variant="outline" className="border-green-500/50 text-green-400 hover:bg-green-500/10">
                      <ActiveIcon className="h-4 w-4 mr-1" />
                      Activate as {FORM_TYPE_LABEL[formType]}
                    </Button>
                  )
                )}
                <Button onClick={() => requestSave(false)} disabled={saving} size="sm">
                  <Save className="h-4 w-4 mr-1" />
                  {saving ? "Saving…" : selectedId ? "Save Form" : "Create Form"}
                </Button>
                <AlertDialog open={askCurrentEvent !== null} onOpenChange={(open) => { if (!open) setAskCurrentEvent(null); }}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{askCurrentEvent?.eventName} already has reports on this form</AlertDialogTitle>
                      <AlertDialogDescription>
                        Earlier events always keep the form they were scouted with. Should the reports already filed at{" "}
                        <strong className="text-foreground">{askCurrentEvent?.eventName}</strong> change to match this edit?
                        Keep them if you are rebuilding the form for a different event; update them if you are fixing the form mid-event.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      {([true, false] as const).map((keep) => (
                        <AlertDialogAction
                          key={String(keep)}
                          variant={keep ? "outline" : "default"}
                          onClick={() => {
                            const activate = askCurrentEvent?.activate;
                            setAskCurrentEvent(null);
                            void (activate ? handleActivate(keep) : saveTemplate(keep));
                          }}
                        >
                          {keep ? "Keep them as scouted" : "Update them too"}
                        </AlertDialogAction>
                      ))}
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
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
                            <strong className="text-foreground">{name || "This form"}</strong> will be permanently deleted. All {fields.length} field{fields.length !== 1 ? "s" : ""} will be lost. Reports already filed with it stay viewable in the format they were scouted with.
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
                      onClick={() => setFormType("default")}
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
                      onClick={() => setFormType("pit")}
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
                      onClick={() => setFormType("super")}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "super"
                          ? "border-amber-500 bg-amber-500/10 text-amber-400 font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Binoculars className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Note Scout</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Qualitative observations</p>
                      </div>
                    </button>
                    <button
                      onClick={() => setFormType("spy")}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                        formType === "spy"
                          ? "border-violet-500 bg-violet-500/10 text-violet-400 font-semibold"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Eye className="h-4 w-4 shrink-0" />
                      <div className="text-left">
                        <p className="font-medium leading-none">Spying</p>
                        <p className="text-[10px] opacity-70 mt-0.5">Per-alliance, unassigned</p>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Form Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2025 Regional Scouting Form" />
                </div>
                {/* Only match and pit scouting pay out (forms.submitForm) */}
                {(formType === "default" || formType === "pit") && (
                <div className="space-y-1.5">
                  <Label>Coins per submission</Label>
                  <Input
                    type="number"
                    min={0}
                    value={coinReward}
                    onChange={(e) => setCoinReward(Math.max(0, Number(e.target.value) || 0))}
                    placeholder="50"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Paid to the scout each time this form is submitted. Set 0 to pay nothing.
                  </p>
                </div>
                )}
                <div className="space-y-1.5">
                  <Label>Description (optional)</Label>
                  <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes about this form…" rows={2} />
                </div>
              </div>

              {/* Pinned auto team# field for every form but spying */}
              {hasPinnedTeam && (
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
              {formType === "spy" && (
                <div className="flex items-center gap-1.5">
                  <div className="p-1 text-muted-foreground/40">
                    <Lock className="h-4 w-4" />
                  </div>
                  <div className="flex-1 flex items-center gap-2 bg-violet-500/5 border border-violet-500/20 border-dashed rounded-lg px-3 py-2 opacity-80">
                    <Eye className="h-4 w-4 text-violet-400 shrink-0" />
                    <span className="text-sm font-medium text-violet-400">Alliance</span>
                    <span className="text-xs px-1.5 py-0.5 rounded-sm bg-violet-500/20 text-violet-400 font-mono ml-1">req</span>
                    <span className="ml-auto text-xs text-muted-foreground italic">picked from playoff alliances · no team#</span>
                  </div>
                </div>
              )}

              {/* Section-grouped field canvas */}
              <div className="space-y-3">
                <DndContext sensors={sensors} collisionDetection={closestCorners} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
                {sectionNames.map((sec, i) => {
                  const secFields = fields.filter((f) => (f.section ?? sectionNames[0]) === sec);
                  return (
                    <SectionBlock
                      key={sec}
                      sectionName={sec}
                      fields={secFields}
                      allSections={sectionNames}
                      fieldTypeMeta={FIELD_TYPES}
                      canDelete={sectionNames.length > 1}
                      onRename={(newName) => renameSection(sec, newName)}
                      onDelete={() => deleteSection(sec)}
                      onUpdateField={updateField}
                      onDeleteField={deleteField}
                      onAddField={(type) => addField(type, sec)}
                      onMoveUp={i > 0 ? () => setSectionNames((p) => moveSection(p, i, -1)) : undefined}
                      onMoveDown={i < sectionNames.length - 1 ? () => setSectionNames((p) => moveSection(p, i, 1)) : undefined}
                    />
                  );
                })}
                </DndContext>
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
                        {f.type === "photo" && (
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" disabled><Camera className="h-4 w-4 mr-1" /> Take Photo</Button>
                            <Button variant="outline" size="sm" disabled>Choose Photo</Button>
                          </div>
                        )}
                        {f.type === "radio" && (
                          <div className="space-y-1.5">
                            {(f.options ?? []).map((o) => (
                              <label key={o} className="flex items-center gap-2 text-sm text-muted-foreground">
                                <input type="radio" disabled className="h-4 w-4" /> {o}
                              </label>
                            ))}
                          </div>
                        )}
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
