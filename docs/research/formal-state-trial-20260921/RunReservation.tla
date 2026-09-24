--------------------------- MODULE RunReservation ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, UseLock, ReserveBeforeLaunch, RejectActive, InitialTerminal
VARIABLES pc, owners, active, terminal, running, started, abandoned,
          unsafeRestart, unsafeTerminal, launches
vars == <<pc, owners, active, terminal, running, started, abandoned,
          unsafeRestart, unsafeTerminal, launches>>
Phases == {"start", "inspect", "reserve", "launch", "lateReserve",
           "running", "commit", "exit", "done"}
Init == /\ pc = [p \in Workers |-> "start"]
        /\ owners = {}
        /\ active = FALSE
        /\ terminal = InitialTerminal
        /\ running = {}
        /\ started = {}
        /\ abandoned = FALSE
        /\ unsafeRestart = FALSE
        /\ unsafeTerminal = FALSE
        /\ launches = 0
Acquire(p) == /\ pc[p] = "start"
              /\ (~UseLock \/ owners = {})
              /\ owners' = owners \cup {p}
              /\ pc' = [pc EXCEPT ![p] = "inspect"]
              /\ UNCHANGED <<active, terminal, running, started, abandoned,
                              unsafeRestart, unsafeTerminal, launches>>
RejectLocked(p) == /\ pc[p] = "start" /\ UseLock /\ owners # {}
                   /\ pc' = [pc EXCEPT ![p] = "done"]
                   /\ UNCHANGED <<owners, active, terminal, running, started,
                                   abandoned, unsafeRestart, unsafeTerminal, launches>>
Inspect(p) == /\ pc[p] = "inspect"
              /\ pc' = [pc EXCEPT ![p] =
                   IF (RejectActive /\ active) \/ terminal THEN "exit" ELSE "reserve"]
              /\ UNCHANGED <<owners, active, terminal, running, started, abandoned,
                              unsafeRestart, unsafeTerminal, launches>>
Reserve(p) == /\ pc[p] = "reserve"
              /\ active' = IF ReserveBeforeLaunch THEN TRUE ELSE active
              /\ pc' = [pc EXCEPT ![p] = "launch"]
              /\ UNCHANGED <<owners, terminal, running, started, abandoned,
                              unsafeRestart, unsafeTerminal, launches>>
Launch(p) == /\ pc[p] = "launch"
             /\ running' = running \cup {p}
             /\ started' = started \cup {p}
             /\ unsafeRestart' = (unsafeRestart \/ abandoned)
             /\ unsafeTerminal' = (unsafeTerminal \/ terminal)
             /\ launches' = launches + 1
             /\ pc' = [pc EXCEPT ![p] =
                        IF ReserveBeforeLaunch THEN "running" ELSE "lateReserve"]
             /\ UNCHANGED <<owners, active, terminal, abandoned>>
LateReserve(p) == /\ pc[p] = "lateReserve"
                  /\ active' = TRUE
                  /\ pc' = [pc EXCEPT ![p] = "running"]
                  /\ UNCHANGED <<owners, terminal, running, started, abandoned,
                                  unsafeRestart, unsafeTerminal, launches>>
ActorDone(p) == /\ pc[p] = "running"
                /\ running' = running \ {p}
                /\ pc' = [pc EXCEPT ![p] = "commit"]
                /\ UNCHANGED <<owners, active, terminal, started, abandoned,
                                unsafeRestart, unsafeTerminal, launches>>
Commit(p) == /\ pc[p] = "commit"
             /\ active' = FALSE
             /\ terminal' = TRUE
             /\ pc' = [pc EXCEPT ![p] = "exit"]
             /\ UNCHANGED <<owners, running, started, abandoned,
                             unsafeRestart, unsafeTerminal, launches>>
Release(p) == /\ pc[p] = "exit"
              /\ owners' = owners \ {p}
              /\ pc' = [pc EXCEPT ![p] = "done"]
              /\ UNCHANGED <<active, terminal, running, started, abandoned,
                              unsafeRestart, unsafeTerminal, launches>>
FaultPhases == {"inspect", "reserve", "launch", "lateReserve", "running", "commit"}
\* Caught errors / handled signals: command cleanup plus run() finally.
Abort(p) == /\ pc[p] \in FaultPhases
            /\ pc' = [pc EXCEPT ![p] = "done"]
            /\ owners' = owners \ {p}
            /\ running' = running \ {p}
            /\ abandoned' = (abandoned \/ (p \in started) \/
                          (ReserveBeforeLaunch /\ pc[p] = "launch"))
            /\ UNCHANGED <<active, terminal, started, unsafeRestart,
                            unsafeTerminal, launches>>
\* SIGKILL: no finally, reservation and lock stay; a child may remain alive.
Kill(p) == /\ pc[p] \in FaultPhases
           /\ pc' = [pc EXCEPT ![p] = "done"]
           /\ abandoned' = (abandoned \/ (p \in started) \/
                          (ReserveBeforeLaunch /\ pc[p] = "launch"))
           /\ UNCHANGED <<owners, active, terminal, running, started,
                           unsafeRestart, unsafeTerminal, launches>>
Next == \E p \in Workers : Acquire(p) \/ RejectLocked(p) \/ Inspect(p) \/
          Reserve(p) \/ Launch(p) \/ LateReserve(p) \/ ActorDone(p) \/
          Commit(p) \/ Release(p) \/ Abort(p) \/ Kill(p)
Spec == Init /\ [][Next]_vars
TypeOK == /\ pc \in [Workers -> Phases] /\ owners \subseteq Workers
          /\ running \subseteq Workers /\ started \subseteq Workers
          /\ active \in BOOLEAN /\ terminal \in BOOLEAN
          /\ abandoned \in BOOLEAN /\ unsafeRestart \in BOOLEAN
          /\ unsafeTerminal \in BOOLEAN /\ launches \in 0..Cardinality(Workers)
NoOverlappingActors == Cardinality(running) <= 1
NoRetryAfterUncertainAttempt == ~unsafeRestart
NoLaunchAfterTerminal == ~unsafeTerminal
=============================================================================
