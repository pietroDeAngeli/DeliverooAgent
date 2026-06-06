;; Deliveroo navigation domain
;; Supports 4-directional grid movement with typed objects.
;; One-way tiles are enforced at the problem level (adjacency facts only in the
;; allowed direction), so the domain itself stays direction-agnostic.
;; Crates can be pushed by the agent onto type-5 tiles (sokoban-style).
(define (domain deliveroo)
    (:requirements :strips :typing)
    (:types agent crate tile)
    (:predicates
        (at       ?a  - agent ?t  - tile)
        (at-crate ?c  - crate ?t  - tile)
        (clear    ?t  - tile)           ;; no crate occupies this tile
        (type5    ?t  - tile)           ;; tile accepts crates (type 5)
        (right ?t1 - tile  ?t2 - tile)
        (left  ?t1 - tile  ?t2 - tile)
        (up    ?t1 - tile  ?t2 - tile)
        (down  ?t1 - tile  ?t2 - tile)
    )

    ;; ── Normal movement (destination must be free of crates) ─────────────────

    (:action move_right
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (right ?from ?to) (clear ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_left
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (left ?from ?to) (clear ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_up
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (up ?from ?to) (clear ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_down
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (down ?from ?to) (clear ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    ;; ── Push actions: agent enters ?mid by pushing crate from ?mid to ?to ────
    ;; ?to must be a type-5 tile and must be clear (no other crate there).

    (:action push_right
        :parameters (?me - agent ?c - crate ?from - tile ?mid - tile ?to - tile)
        :precondition (and (at ?me ?from) (right ?from ?mid) (right ?mid ?to)
                          (at-crate ?c ?mid) (type5 ?to) (clear ?to))
        :effect       (and (at ?me ?mid)         (not (at ?me ?from))
                          (at-crate ?c ?to)      (not (at-crate ?c ?mid))
                          (clear ?mid)           (not (clear ?to)))
    )

    (:action push_left
        :parameters (?me - agent ?c - crate ?from - tile ?mid - tile ?to - tile)
        :precondition (and (at ?me ?from) (left ?from ?mid) (left ?mid ?to)
                          (at-crate ?c ?mid) (type5 ?to) (clear ?to))
        :effect       (and (at ?me ?mid)         (not (at ?me ?from))
                          (at-crate ?c ?to)      (not (at-crate ?c ?mid))
                          (clear ?mid)           (not (clear ?to)))
    )

    (:action push_up
        :parameters (?me - agent ?c - crate ?from - tile ?mid - tile ?to - tile)
        :precondition (and (at ?me ?from) (up ?from ?mid) (up ?mid ?to)
                          (at-crate ?c ?mid) (type5 ?to) (clear ?to))
        :effect       (and (at ?me ?mid)         (not (at ?me ?from))
                          (at-crate ?c ?to)      (not (at-crate ?c ?mid))
                          (clear ?mid)           (not (clear ?to)))
    )

    (:action push_down
        :parameters (?me - agent ?c - crate ?from - tile ?mid - tile ?to - tile)
        :precondition (and (at ?me ?from) (down ?from ?mid) (down ?mid ?to)
                          (at-crate ?c ?mid) (type5 ?to) (clear ?to))
        :effect       (and (at ?me ?mid)         (not (at ?me ?from))
                          (at-crate ?c ?to)      (not (at-crate ?c ?mid))
                          (clear ?mid)           (not (clear ?to)))
    )
)
