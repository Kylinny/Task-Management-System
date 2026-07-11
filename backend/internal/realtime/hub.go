package realtime

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"happyrobot/backend/internal/domain"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second
)

type Hub struct {
	mu          sync.RWMutex
	subscribers map[string]map[*Client]bool
}

type Client struct {
	projectID string
	conn      *websocket.Conn
	send      chan domain.Event
}

func NewHub() *Hub {
	return &Hub{subscribers: map[string]map[*Client]bool{}}
}

func (h *Hub) Publish(event domain.Event) {
	h.mu.RLock()
	var slowClients []*Client
	for client := range h.subscribers[event.ProjectID] {
		select {
		case client.send <- event:
		default:
			slowClients = append(slowClients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range slowClients {
		h.unregister(client)
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request, projectID string, replay []domain.Event) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := &Client{
		projectID: projectID,
		conn:      conn,
		send:      make(chan domain.Event, len(replay)+64),
	}
	for _, event := range replay {
		client.send <- event
	}
	h.register(client)

	go client.writePump(h)
	client.readPump(h)
}

func (h *Hub) register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.subscribers[client.projectID] == nil {
		h.subscribers[client.projectID] = map[*Client]bool{}
	}
	h.subscribers[client.projectID][client] = true
}

func (h *Hub) unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closeClientLocked(client)
}

func (h *Hub) closeClientLocked(client *Client) {
	if _, ok := h.subscribers[client.projectID][client]; !ok {
		return
	}
	delete(h.subscribers[client.projectID], client)
	if len(h.subscribers[client.projectID]) == 0 {
		delete(h.subscribers, client.projectID)
	}
	close(client.send)
	_ = client.conn.Close()
}

func (c *Client) readPump(h *Hub) {
	defer h.unregister(c)

	c.conn.SetReadLimit(1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		if _, _, err := c.conn.NextReader(); err != nil {
			return
		}
	}
}

func (c *Client) writePump(h *Hub) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		h.unregister(c)
	}()

	for {
		select {
		case event, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteJSON(event); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
