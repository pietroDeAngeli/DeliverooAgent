;; Deliveroo navigation domain
;; Supports 4-directional grid movement with typed objects.
;; One-way tiles are enforced at the problem level (adjacency facts only in the
;; allowed direction), so the domain itself stays direction-agnostic.
(define (domain deliveroo)
    (:requirements :strips :typing)
    (:types agent tile)
    (:predicates
        (at    ?a  - agent ?t  - tile)
        (right ?t1 - tile  ?t2 - tile)
        (left  ?t1 - tile  ?t2 - tile)
        (up    ?t1 - tile  ?t2 - tile)
        (down  ?t1 - tile  ?t2 - tile)
    )

    (:action move_right
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (right ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_left
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (left ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_up
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (up ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )

    (:action move_down
        :parameters (?me - agent ?from - tile ?to - tile)
        :precondition (and (at ?me ?from) (down ?from ?to))
        :effect       (and (at ?me ?to) (not (at ?me ?from)))
    )
)
