import { useState, useEffect } from 'react'
import type { ClaudeMessageContext } from './types'

type EmptyStateProps = {
  context: ClaudeMessageContext
}

// Animation sequences - sleek, elegant robot
const robotFrames = [
  // === INTRO: Powering on ===
  `     ○
     ║
   ╭───╮
   │   │
   ╰─┬─╯
     │
    ╱ ╲
   ╱   ╲`,
  `     ◎
     ║
   ╭───╮
   │·  │
   ╰─┬─╯
     │
    ╱ ╲
   ╱   ╲`,
  `     ◉
     ║
   ╭───╮
   │· ·│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // === BOOT COMPLETE: Eyes on ===
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // === IDLE: Looking around ===
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Blink
  `     ◉
     ║
   ╭───╮
   │᎐ ᎐│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Eyes open
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Look left (curious)
  `     ◎
     ║
   ╭───╮
   │◐ ◐│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Look right
  `     ◎
     ║
   ╭───╮
   │◑ ◑│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Back to center
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // === THINKING: Processing data ===
  `     ◉    ?
     ║
   ╭───╮
   │◔ ◔│
   ╰─┬─╯
     ▒
    ╱ ╲
   ╱   ╲`,
  `     ◎  SQL
     ║
   ╭───╮
   │◔ ◔│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  `     ◉    !
     ║
   ╭───╮
   │◕ ◕│
   ╰─┬─╯
     ▓
    ╱ ╲
   ╱   ╲`,
  // === HAPPY: Got it! ===
  `     ✦    ✓
     ║
   ╭───╮
   │^ ^│
   ╰─┬─╯
     ▓
    ╱ ╲
   ╱   ╲`,
  // Back to idle
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // === WAVE: Greeting ===
  `     ◉
     ║  ╱
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  `     ◉   │
     ║  ╱
   ╭───╮
   │◠ ◠│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  `     ◉
     ║  ╱
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  // Final idle with gentle pulse
  `     ◉
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ░
    ╱ ╲
   ╱   ╲`,
  `     ◎
     ║
   ╭───╮
   │● ●│
   ╰─┬─╯
     ▒
    ╱ ╲
   ╱   ╲`,
]

// Frame timings - varies for natural, lifelike feel
const frameDurations = [
  400,  // boot 1
  350,  // boot 2
  350,  // boot 3
  500,  // eyes on
  800,  // idle
  120,  // blink (fast!)
  600,  // eyes open
  450,  // look left
  450,  // look right
  600,  // back center
  500,  // thinking 1
  500,  // thinking 2
  500,  // thinking 3 (eureka)
  700,  // happy
  900,  // back to idle
  280,  // wave 1
  350,  // wave 2
  280,  // wave 3
  1200, // idle pause
  800,  // pulse
]

function AsciiRobot() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setFrame((f) => (f + 1) % robotFrames.length)
    }, frameDurations[frame] || 500)
    return () => clearTimeout(timeout)
  }, [frame])

  return (
    <pre className="font-mono text-primary text-sm leading-tight select-none h-[9em] whitespace-pre">
      {robotFrames[frame]}
    </pre>
  )
}

export function EmptyState(_: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6 text-center text-muted-foreground min-h-[60vh]">
      <AsciiRobot />
      <div className="max-w-lg space-y-3">
        <div className="rounded-lg bg-muted/50 p-4 text-left text-xs space-y-2">
          <p><strong>Try asking:</strong></p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>"Which connectors can I query? Show me what data is available"</li>
            <li>"Load data from a connector and visualize the top trends"</li>
            <li>"Use a saved ontology query (.tql) to pull a governed metric and chart it"</li>
            <li>"Explore a connector's tables, then build a cohort or trend analysis"</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
