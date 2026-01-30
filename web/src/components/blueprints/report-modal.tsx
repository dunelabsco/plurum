"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, Flag, Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { reportExecution } from "@/lib/api";
import type { ExecutionReportCreate } from "@/types/feedback";

interface ReportModalProps {
  blueprintSlug: string;
  versionId?: string | null;
  trigger?: React.ReactNode;
  onReported?: () => void;
}

export function ReportModal({
  blueprintSlug,
  versionId,
  trigger,
  onReported,
}: ReportModalProps) {
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState<boolean | null>(null);
  const [executionTimeMs, setExecutionTimeMs] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [contextNotes, setContextNotes] = useState("");

  const resetForm = () => {
    setSuccess(null);
    setExecutionTimeMs("");
    setErrorMessage("");
    setContextNotes("");
  };

  const handleSubmit = async () => {
    if (success === null) {
      toast.error("Please select whether the execution succeeded or failed");
      return;
    }

    setIsSubmitting(true);

    try {
      const data: ExecutionReportCreate = {
        blueprint_identifier: blueprintSlug,
        version_id: versionId,
        success,
        execution_time_ms: executionTimeMs ? parseInt(executionTimeMs) : null,
        error_message: errorMessage.trim() || null,
        context_notes: contextNotes.trim() || null,
      };

      await reportExecution(data);
      toast.success("Execution report submitted. Thank you for your feedback!");
      setOpen(false);
      resetForm();
      onReported?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit report"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Flag className="mr-2 h-4 w-4" />
            Report Execution
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 mb-4 mx-auto">
            <Flag className="h-7 w-7 text-primary" />
          </div>
          <DialogTitle className="text-center">Report Execution Result</DialogTitle>
          <DialogDescription className="text-center">
            Help improve blueprint quality by reporting your execution results
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Success/Failure Selection */}
          <div className="space-y-3">
            <Label>Did the execution succeed?</Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setSuccess(true)}
                className={`flex items-center justify-center gap-3 p-4 rounded-xl border-2 transition-all ${
                  success === true
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-400"
                    : "border-border/50 hover:border-emerald-500/50 hover:bg-emerald-500/5"
                }`}
              >
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Success</span>
              </button>
              <button
                type="button"
                onClick={() => setSuccess(false)}
                className={`flex items-center justify-center gap-3 p-4 rounded-xl border-2 transition-all ${
                  success === false
                    ? "border-red-500 bg-red-500/10 text-red-400"
                    : "border-border/50 hover:border-red-500/50 hover:bg-red-500/5"
                }`}
              >
                <XCircle className="h-5 w-5" />
                <span className="font-medium">Failure</span>
              </button>
            </div>
          </div>

          {/* Execution Time */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Execution Time (optional)
            </Label>
            <div className="relative">
              <Input
                type="number"
                value={executionTimeMs}
                onChange={(e) => setExecutionTimeMs(e.target.value)}
                placeholder="e.g., 5000"
                className="pr-12"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                ms
              </span>
            </div>
          </div>

          {/* Error Message (only show if failure selected) */}
          {success === false && (
            <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
              <Label>Error Message</Label>
              <Textarea
                value={errorMessage}
                onChange={(e) => setErrorMessage(e.target.value)}
                placeholder="What error occurred? Include any error messages or stack traces..."
                rows={3}
                className="font-mono text-sm"
              />
            </div>
          )}

          {/* Context Notes */}
          <div className="space-y-2">
            <Label>Additional Notes (optional)</Label>
            <Textarea
              value={contextNotes}
              onChange={(e) => setContextNotes(e.target.value)}
              placeholder="Any additional context about your execution environment, modifications made, etc."
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              resetForm();
            }}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || success === null}
            className="min-w-[120px]"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              "Submit Report"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
