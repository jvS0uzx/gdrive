from alembic import op

revision = "0003"
down_revision = "0002"

STATEMENTS = [
    """
    CREATE TABLE alerts (
        id bigserial PRIMARY KEY,
        order_id bigint NOT NULL REFERENCES orders (id),
        courier_id integer REFERENCES couriers (id),
        kind text NOT NULL CHECK (kind IN ('sinal_perdido', 'parado', 'desvio', 'atraso', 'sem_entregador')),
        detail jsonb NOT NULL DEFAULT '{}',
        opened_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz
    )
    """,
    "CREATE UNIQUE INDEX alerts_one_open_per_kind ON alerts (order_id, kind) WHERE closed_at IS NULL",
    "CREATE INDEX alerts_order ON alerts (order_id)",
    "ALTER TABLE orders ADD COLUMN delivered_at timestamptz",
]


def upgrade():
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade():
    op.execute("ALTER TABLE orders DROP COLUMN delivered_at")
    op.execute("DROP TABLE alerts")
