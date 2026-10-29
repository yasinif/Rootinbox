package domain

type RateDimension int

const (
	DimensionIP RateDimension = iota
	DimensionUser
	DimensionBoth
)

type RouteClass struct {
	Name          string
	Dimension     RateDimension
	PerMinuteIP   int
	PerMinuteUser int
}

var (
	RouteClassAuthUnauthenticated = RouteClass{"auth.unauthenticated", DimensionIP, 20, 0}
	RouteClassRestGeneral         = RouteClass{"rest.general", DimensionUser, 0, 600}
	RouteClassMediaChunk          = RouteClass{"media.chunk", DimensionUser, 0, 30}
	RouteClassPushSubscribe       = RouteClass{"push.subscribe", DimensionUser, 0, 5}
	RouteClassDiscovery           = RouteClass{"discovery", DimensionBoth, 120, 600}
	RouteClassAdmin               = RouteClass{"admin", DimensionIP, 30, 0}
	RouteClassUserSearch          = RouteClass{"user.search", DimensionUser, 0, 10} // Amendment RFC-0002-A: 10/min per user
)
