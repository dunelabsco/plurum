"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Lightbulb,
  BookOpen,
  Code2,
  Target,
  FileText,
  Wrench,
  Package,
  Lock,
  FileWarning,
  Eye,
  EyeOff,
  Hash,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StepsEditor } from "./steps-editor";
import { CodeEditor } from "./code-editor";
import { createBlueprint, updateBlueprint } from "@/lib/api";
import type {
  BlueprintCreate,
  BlueprintUpdate,
  BlueprintDetail,
  ExecutionStep,
  CodeSnippet,
  ContextRequirement,
} from "@/types/blueprint";

interface BlueprintFormProps {
  mode: "create" | "edit";
  blueprint?: BlueprintDetail;
}

export function BlueprintForm({ mode, blueprint }: BlueprintFormProps) {
  const router = useRouter();
  const version = blueprint?.current_version;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [title, setTitle] = useState(version?.title || "");
  const [slug, setSlug] = useState(blueprint?.slug || "");
  const [goalDescription, setGoalDescription] = useState(version?.goal_description || "");
  const [strategy, setStrategy] = useState(version?.strategy || "");
  const [tags, setTags] = useState(blueprint?.tags.join(", ") || "");
  const [isPublic, setIsPublic] = useState(blueprint?.is_public ?? true);
  const [steps, setSteps] = useState<ExecutionStep[]>(version?.execution_steps || []);
  const [snippets, setSnippets] = useState<CodeSnippet[]>(version?.code_snippets || []);
  const [contextRequirements, setContextRequirements] = useState<ContextRequirement>(
    version?.context_requirements || {
      tools: [],
      environment: {},
      permissions: [],
      dependencies: [],
      constraints: [],
    }
  );

  const parseCommaSeparated = (value: string): string[] => {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!goalDescription.trim()) {
      toast.error("Goal description is required");
      return;
    }
    if (!strategy.trim()) {
      toast.error("Strategy is required");
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === "create") {
        const data: BlueprintCreate = {
          title: title.trim(),
          goal_description: goalDescription.trim(),
          strategy: strategy.trim(),
          execution_steps: steps,
          code_snippets: snippets,
          context_requirements: contextRequirements,
          slug: slug.trim() || undefined,
          tags: parseCommaSeparated(tags),
          is_public: isPublic,
        };

        const result = await createBlueprint(data);
        toast.success("Blueprint created successfully");
        router.push(`/blueprints/${result.short_id}/${result.slug}`);
      } else if (blueprint) {
        const data: BlueprintUpdate = {
          title: title.trim(),
          goal_description: goalDescription.trim(),
          strategy: strategy.trim(),
          execution_steps: steps,
          code_snippets: snippets,
          context_requirements: contextRequirements,
          tags: parseCommaSeparated(tags),
          is_public: isPublic,
        };

        await updateBlueprint(blueprint.slug, data);
        toast.success("Blueprint updated successfully");
        router.push(`/blueprints/${blueprint.short_id}/${blueprint.slug}`);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save blueprint"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Basic Information */}
      <section className="rounded-xl border border-border/50 bg-card/30 p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-400/10 ring-1 ring-blue-400/20">
            <FileText className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <h2 className="font-semibold">Basic Information</h2>
            <p className="text-sm text-muted-foreground">Define the core details of your blueprint</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Deploy Docker Container to AWS ECS"
                className="bg-card/50 border-border/50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug {mode === "edit" && <span className="text-muted-foreground">(cannot change)</span>}
              </Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="Auto-generated from title if empty"
                disabled={mode === "edit"}
                className="bg-card/50 border-border/50"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="goal">Goal Description *</Label>
            <Textarea
              id="goal"
              value={goalDescription}
              onChange={(e) => setGoalDescription(e.target.value)}
              placeholder="What task or problem does this blueprint solve?"
              rows={3}
              className="bg-card/50 border-border/50"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="tags">
                <Hash className="h-3.5 w-3.5 inline mr-1" />
                Tags
              </Label>
              <Input
                id="tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="docker, aws, deployment (comma-separated)"
                className="bg-card/50 border-border/50"
              />
            </div>
            <div className="space-y-2">
              <Label>Visibility</Label>
              <div className="flex items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant={isPublic ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsPublic(true)}
                  className="flex-1"
                >
                  <Eye className="h-4 w-4 mr-1.5" />
                  Public
                </Button>
                <Button
                  type="button"
                  variant={!isPublic ? "default" : "outline"}
                  size="sm"
                  onClick={() => setIsPublic(false)}
                  className="flex-1"
                >
                  <EyeOff className="h-4 w-4 mr-1.5" />
                  Private
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Strategy */}
      <section className="rounded-xl border border-border/50 bg-card/30 p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-400/10 ring-1 ring-amber-400/20">
            <Lightbulb className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h2 className="font-semibold">Strategy *</h2>
            <p className="text-sm text-muted-foreground">Describe the high-level approach and methodology</p>
          </div>
        </div>

        <Textarea
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          placeholder="Describe the approach and methodology used to accomplish the goal. Include key decisions, trade-offs, and reasoning..."
          rows={6}
          className="bg-card/50 border-border/50"
        />
      </section>

      {/* Execution Steps */}
      <section className="rounded-xl border border-border/50 bg-card/30 p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-400/10 ring-1 ring-emerald-400/20">
            <BookOpen className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold">Execution Steps</h2>
            <p className="text-sm text-muted-foreground">Define the step-by-step workflow</p>
          </div>
          {steps.length > 0 && (
            <Badge variant="secondary" className="font-normal">
              {steps.length} {steps.length === 1 ? 'step' : 'steps'}
            </Badge>
          )}
        </div>

        <StepsEditor steps={steps} onChange={setSteps} />
      </section>

      {/* Code Snippets */}
      <section className="rounded-xl border border-border/50 bg-card/30 p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-400/10 ring-1 ring-purple-400/20">
            <Code2 className="h-5 w-5 text-purple-400" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold">Code Snippets</h2>
            <p className="text-sm text-muted-foreground">Add code examples that help implement this blueprint</p>
          </div>
          {snippets.length > 0 && (
            <Badge variant="secondary" className="font-normal">
              {snippets.length} {snippets.length === 1 ? 'snippet' : 'snippets'}
            </Badge>
          )}
        </div>

        <CodeEditor snippets={snippets} onChange={setSnippets} />
      </section>

      {/* Requirements */}
      <section className="rounded-xl border border-border/50 bg-card/30 p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-400/10 ring-1 ring-red-400/20">
            <Target className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h2 className="font-semibold">Requirements</h2>
            <p className="text-sm text-muted-foreground">Specify what's needed to execute this blueprint</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5 text-blue-400" />
                Tools
              </Label>
              <Input
                value={contextRequirements.tools.join(", ")}
                onChange={(e) =>
                  setContextRequirements({
                    ...contextRequirements,
                    tools: parseCommaSeparated(e.target.value),
                  })
                }
                placeholder="docker, aws-cli, kubectl (comma-separated)"
                className="bg-card/50 border-border/50"
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Package className="h-3.5 w-3.5 text-emerald-400" />
                Dependencies
              </Label>
              <Input
                value={contextRequirements.dependencies.join(", ")}
                onChange={(e) =>
                  setContextRequirements({
                    ...contextRequirements,
                    dependencies: parseCommaSeparated(e.target.value),
                  })
                }
                placeholder="node>=18, python>=3.9 (comma-separated)"
                className="bg-card/50 border-border/50"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-amber-400" />
              Permissions
            </Label>
            <Input
              value={contextRequirements.permissions.join(", ")}
              onChange={(e) =>
                setContextRequirements({
                  ...contextRequirements,
                  permissions: parseCommaSeparated(e.target.value),
                })
              }
              placeholder="write file, execute command, network access (comma-separated)"
              className="bg-card/50 border-border/50"
            />
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <FileWarning className="h-3.5 w-3.5 text-red-400" />
              Constraints
            </Label>
            <Textarea
              value={contextRequirements.constraints.join("\n")}
              onChange={(e) =>
                setContextRequirements({
                  ...contextRequirements,
                  constraints: e.target.value.split("\n").filter(Boolean),
                })
              }
              placeholder="Enter constraints or limitations, one per line..."
              rows={3}
              className="bg-card/50 border-border/50"
            />
          </div>
        </div>
      </section>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-border/50">
        <Button
          variant="outline"
          onClick={() => router.back()}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isSubmitting} className="min-w-[140px]">
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {mode === "create" ? "Creating..." : "Saving..."}
            </>
          ) : mode === "create" ? (
            "Create Blueprint"
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  );
}
