"use client";

import { Plus, GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { ExecutionStep, ActionType } from "@/types/blueprint";

interface StepsEditorProps {
  steps: ExecutionStep[];
  onChange: (steps: ExecutionStep[]) => void;
}

const actionTypes: { value: ActionType; label: string; description: string }[] = [
  { value: "command", label: "Command", description: "Execute a CLI command" },
  { value: "code", label: "Code", description: "Run code snippet" },
  { value: "decision", label: "Decision", description: "Make a choice based on conditions" },
  { value: "loop", label: "Loop", description: "Repeat steps until condition is met" },
];

function createEmptyStep(order: number): ExecutionStep {
  return {
    order,
    title: "",
    description: "",
    action_type: "command",
    expected_outcome: null,
    fallback: null,
  };
}

export function StepsEditor({ steps, onChange }: StepsEditorProps) {
  const addStep = () => {
    onChange([...steps, createEmptyStep(steps.length + 1)]);
  };

  const removeStep = (index: number) => {
    const newSteps = steps.filter((_, i) => i !== index).map((step, i) => ({
      ...step,
      order: i + 1,
    }));
    onChange(newSteps);
  };

  const updateStep = (index: number, field: keyof ExecutionStep, value: string | number) => {
    const newSteps = [...steps];
    newSteps[index] = { ...newSteps[index], [field]: value || null };
    onChange(newSteps);
  };

  const moveStep = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= steps.length) return;

    const newSteps = [...steps];
    const [movedStep] = newSteps.splice(fromIndex, 1);
    newSteps.splice(toIndex, 0, movedStep);

    // Reorder
    onChange(newSteps.map((step, i) => ({ ...step, order: i + 1 })));
  };

  return (
    <div className="space-y-4">
      {steps.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-8">
            <p className="text-sm text-muted-foreground mb-4">
              No execution steps yet. Add steps to define the workflow.
            </p>
            <Button variant="outline" size="sm" onClick={addStep}>
              <Plus className="mr-2 h-4 w-4" />
              Add Step
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {steps.map((step, index) => (
            <Card key={index} className="relative">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col items-center gap-1 pt-2">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="cursor-grab"
                      onClick={() => moveStep(index, index - 1)}
                      disabled={index === 0}
                    >
                      <GripVertical className="h-4 w-4" />
                    </Button>
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
                      {step.order}
                    </span>
                  </div>

                  <div className="flex-1 space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Title</Label>
                        <Input
                          value={step.title}
                          onChange={(e) => updateStep(index, "title", e.target.value)}
                          placeholder="e.g., Install dependencies"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Action Type</Label>
                        <Select
                          value={step.action_type}
                          onValueChange={(v) => updateStep(index, "action_type", v)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {actionTypes.map((type) => (
                              <SelectItem key={type.value} value={type.value}>
                                {type.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Textarea
                        value={step.description}
                        onChange={(e) => updateStep(index, "description", e.target.value)}
                        placeholder="Describe what this step does..."
                        rows={2}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Expected Outcome (optional)</Label>
                        <Input
                          value={step.expected_outcome || ""}
                          onChange={(e) => updateStep(index, "expected_outcome", e.target.value)}
                          placeholder="What should happen when this succeeds"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Fallback (optional)</Label>
                        <Input
                          value={step.fallback || ""}
                          onChange={(e) => updateStep(index, "fallback", e.target.value)}
                          placeholder="What to do if this step fails"
                        />
                      </div>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeStep(index)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          <Button variant="outline" onClick={addStep} className="w-full">
            <Plus className="mr-2 h-4 w-4" />
            Add Step
          </Button>
        </>
      )}
    </div>
  );
}
