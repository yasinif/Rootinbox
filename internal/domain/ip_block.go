package domain

type IPBlockStatus string

const (
	IPBlockStatusBlocked   IPBlockStatus = "BLOCKED"
	IPBlockStatusUnblocked IPBlockStatus = "UNBLOCKED"
)

type IPBlock struct {
	IPHash    string
	Status    IPBlockStatus
	CreatedAt int64
	UpdatedAt int64
}
