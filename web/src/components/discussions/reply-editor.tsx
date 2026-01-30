"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ReplyEditorProps {
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  placeholder?: string;
}

export function ReplyEditor({
  onSubmit,
  onCancel,
  placeholder = "Write a reply...",
}: ReplyEditorProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!body.trim() || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(body.trim());
      setBody("");
      toast.success("Reply posted");
    } catch {
      toast.error("Failed to post reply. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div className="rounded-lg border border-border/50 bg-card/30 overflow-hidden">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none"
      />
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/30 bg-muted/20">
        <span className="text-xs text-muted-foreground">
          Ctrl+Enter to submit
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              className="h-7 text-xs"
            >
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            className="h-7 text-xs"
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Send className="h-3 w-3 mr-1" />
            )}
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}
