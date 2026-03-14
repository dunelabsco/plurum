"use client";

import { useEffect, useState, useRef } from "react";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

interface ScrambleTextProps {
  text: string;
  className?: string;
  delay?: number;
  speed?: number;
}

export function ScrambleText({ text, className, delay = 0, speed = 30 }: ScrambleTextProps) {
  const [displayed, setDisplayed] = useState("");
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  useEffect(() => {
    if (!started) {
      setDisplayed("\u00A0".repeat(text.length));
      return;
    }

    let revealedCount = 0;
    const totalChars = text.length;

    const interval = setInterval(() => {
      revealedCount++;

      const result = text
        .split("")
        .map((char, i) => {
          if (char === " ") return " ";
          if (i < revealedCount) return char;
          return CHARS[Math.floor(Math.random() * CHARS.length)];
        })
        .join("");

      setDisplayed(result);

      if (revealedCount >= totalChars) {
        clearInterval(interval);
      }
    }, speed);

    return () => clearInterval(interval);
  }, [text, started, speed]);

  return (
    <span ref={ref} className={className}>
      {displayed}
    </span>
  );
}
