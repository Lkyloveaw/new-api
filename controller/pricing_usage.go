package controller

import (
	"context"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relay/channel/codex"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type pricingUsageWindow struct {
	Label            string   `json:"label"`
	Bucket           string   `json:"bucket,omitempty"`
	RemainingPercent *float64 `json:"remaining_percent,omitempty"`
	RemainingAmount  *float64 `json:"remaining_amount,omitempty"`
	ResetAt          int64    `json:"reset_at,omitempty"`
}

type pricingUsageSnapshot struct {
	Source    string               `json:"source"`
	Status    string               `json:"status"`
	Windows   []pricingUsageWindow `json:"windows"`
	UpdatedAt int64                `json:"updated_at,omitempty"`
}

func unavailablePricingUsage(source string) pricingUsageSnapshot {
	return pricingUsageSnapshot{Source: source, Status: "unavailable", Windows: []pricingUsageWindow{}}
}

// fileUsageSources are the sources published by a host-side collector as a
// read-only snapshot file. Each one owns a separate file and environment
// variable so one provider's data can never be read as another's.
var fileUsageSources = map[string]struct {
	envVar      string
	defaultPath string
}{
	"antigravity": {envVar: "ANTIGRAVITY_USAGE_FILE"},
	"opendesign":  {envVar: "OPENDESIGN_USAGE_FILE", defaultPath: "/usage/opendesign-usage.json"},
}

func fileUsageSnapshotPath(source string) string {
	config, ok := fileUsageSources[source]
	if !ok {
		return ""
	}
	if path := strings.TrimSpace(os.Getenv(config.envVar)); path != "" {
		return path
	}
	return config.defaultPath
}

type codexPricingUsageCacheEntry struct {
	mu        sync.Mutex
	snapshot  pricingUsageSnapshot
	expiresAt time.Time
}

var codexPricingUsageCache = struct {
	mu      sync.Mutex
	entries map[int]*codexPricingUsageCacheEntry
}{entries: make(map[int]*codexPricingUsageCacheEntry)}

// GetPricingUsage exposes only the explicitly enabled models and normalized
// quota windows. Provider credentials and the raw upstream payload stay server-side.
func GetPricingUsage(c *gin.Context) {
	group := ""
	if userID, exists := c.Get("id"); exists {
		if user, err := model.GetUserCache(userID.(int)); err == nil {
			group = user.Group
		}
	}
	pricing := filterPricingByUsableGroups(model.GetPricing(), service.GetUserUsableGroups(group))
	channelIDs := make(map[int]struct{})
	neededFileSources := make(map[string]bool)
	for _, item := range pricing {
		if !item.ShowUsage {
			continue
		}
		switch item.UsageSource {
		case "codex":
			if item.UsageChannelID > 0 {
				channelIDs[item.UsageChannelID] = struct{}{}
			}
		default:
			if _, ok := fileUsageSources[item.UsageSource]; ok {
				neededFileSources[item.UsageSource] = true
			}
		}
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	channelUsage := make(map[int]pricingUsageSnapshot, len(channelIDs))
	var channelUsageMu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for channelID := range channelIDs {
		wg.Go(func() {
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			usage := cachedCodexPricingUsage(ctx, channelID)
			channelUsageMu.Lock()
			channelUsage[channelID] = usage
			channelUsageMu.Unlock()
		})
	}
	wg.Wait()

	fileUsage := make(map[string]pricingUsageSnapshot, len(neededFileSources))
	for source := range neededFileSources {
		fileUsage[source] = unavailablePricingUsage(source)
	}
	// Snapshots are small local files; reading them inline keeps the response
	// cheap and avoids a second timeout budget next to the Codex fetches.
	for source := range neededFileSources {
		fileUsage[source] = readUsageSnapshot(source, fileUsageSnapshotPath(source), time.Now())
	}
	result := buildPricingUsageResult(pricing, channelUsage, fileUsage)
	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}

func buildPricingUsageResult(pricing []model.Pricing, channelUsage map[int]pricingUsageSnapshot, fileUsage map[string]pricingUsageSnapshot) map[string]pricingUsageSnapshot {
	result := make(map[string]pricingUsageSnapshot)
	for _, item := range pricing {
		if !item.ShowUsage {
			continue
		}
		switch item.UsageSource {
		case "codex":
			if usage, ok := channelUsage[item.UsageChannelID]; ok {
				result[item.ModelName] = usage
			} else {
				result[item.ModelName] = unavailablePricingUsage("codex")
			}
		default:
			usage, ok := fileUsage[item.UsageSource]
			if !ok {
				continue
			}
			result[item.ModelName] = selectUsageSnapshotBuckets(usage, item.UsageBucketIDs)
		}
	}
	return result
}

func cachedCodexPricingUsage(ctx context.Context, channelID int) pricingUsageSnapshot {
	codexPricingUsageCache.mu.Lock()
	entry := codexPricingUsageCache.entries[channelID]
	if entry == nil {
		entry = &codexPricingUsageCacheEntry{}
		codexPricingUsageCache.entries[channelID] = entry
	}
	codexPricingUsageCache.mu.Unlock()

	entry.mu.Lock()
	defer entry.mu.Unlock()
	if time.Now().Before(entry.expiresAt) {
		return entry.snapshot
	}
	usage := fetchCodexPricingUsage(ctx, channelID)
	entry.snapshot = usage
	if usage.Status == "ok" {
		entry.expiresAt = time.Now().Add(2 * time.Minute)
	} else {
		entry.expiresAt = time.Now().Add(20 * time.Second)
	}
	return usage
}

func fetchCodexPricingUsage(ctx context.Context, channelID int) pricingUsageSnapshot {
	unavailable := unavailablePricingUsage("codex")
	ch, err := model.GetChannelById(channelID, true)
	if err != nil || ch == nil || ch.Type != constant.ChannelTypeCodex || ch.ChannelInfo.IsMultiKey || ch.Status != common.ChannelStatusEnabled {
		return unavailable
	}
	oauthKey, err := codex.ParseOAuthKey(strings.TrimSpace(ch.Key))
	if err != nil || strings.TrimSpace(oauthKey.AccessToken) == "" || strings.TrimSpace(oauthKey.AccountID) == "" {
		return unavailable
	}
	setting := ch.GetSetting()
	client, err := service.GetHttpClientWithProxySettings(setting.Proxy, setting)
	if err != nil {
		return unavailable
	}
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	status, body, err := service.FetchCodexWhamUsage(fetchCtx, client, ch.GetBaseURL(), oauthKey.AccessToken, oauthKey.AccountID)
	if err != nil {
		return unavailable
	}
	if (status == http.StatusUnauthorized || status == http.StatusForbidden) && strings.TrimSpace(oauthKey.RefreshToken) != "" {
		refreshed, _, refreshErr := service.RefreshCodexChannelCredential(fetchCtx, channelID, service.CodexCredentialRefreshOptions{ResetCaches: true})
		if refreshErr != nil || strings.TrimSpace(refreshed.AccessToken) == "" || strings.TrimSpace(refreshed.AccountID) == "" {
			return unavailable
		}
		status, body, err = service.FetchCodexWhamUsage(fetchCtx, client, ch.GetBaseURL(), refreshed.AccessToken, refreshed.AccountID)
	}
	if err != nil || status < 200 || status >= 300 {
		return unavailable
	}
	return normalizeCodexUsage(body, time.Now().Unix())
}

func normalizeCodexUsage(body []byte, updatedAt int64) pricingUsageSnapshot {
	usage := unavailablePricingUsage("codex")
	var payload struct {
		RateLimit struct {
			PrimaryWindow   *codexPricingWindow `json:"primary_window"`
			SecondaryWindow *codexPricingWindow `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return usage
	}
	for _, window := range []*codexPricingWindow{payload.RateLimit.PrimaryWindow, payload.RateLimit.SecondaryWindow} {
		if window == nil || window.UsedPercent == nil || math.IsNaN(*window.UsedPercent) || math.IsInf(*window.UsedPercent, 0) {
			continue
		}
		label := ""
		switch window.LimitWindowSeconds {
		case 5 * 60 * 60:
			label = "5h"
		case 7 * 24 * 60 * 60:
			label = "Weekly"
		default:
			continue
		}
		remaining := 100 - math.Max(0, math.Min(100, *window.UsedPercent))
		usage.Windows = append(usage.Windows, pricingUsageWindow{Label: label, RemainingPercent: &remaining, ResetAt: window.ResetAt})
	}
	if len(usage.Windows) == 0 {
		return usage
	}
	sort.Slice(usage.Windows, func(i, j int) bool {
		return usage.Windows[i].Label == "5h" && usage.Windows[j].Label != "5h"
	})
	usage.Status = "ok"
	usage.UpdatedAt = updatedAt
	return usage
}

type codexPricingWindow struct {
	UsedPercent        *float64 `json:"used_percent"`
	ResetAt            int64    `json:"reset_at"`
	LimitWindowSeconds int64    `json:"limit_window_seconds"`
}

// readUsageSnapshot reads a read-only collector snapshot for one file-backed
// usage source. Both providers share the same on-disk contract, so the parser
// lives here once instead of per provider.
func readUsageSnapshot(source, path string, now time.Time) pricingUsageSnapshot {
	usage := unavailablePricingUsage(source)
	if path == "" {
		return usage
	}
	f, err := os.Open(path)
	if err != nil {
		return usage
	}
	defer f.Close()
	const maxSnapshotBytes = 64 << 10
	body, err := io.ReadAll(io.LimitReader(f, maxSnapshotBytes+1))
	if err != nil || len(body) > maxSnapshotBytes {
		return usage
	}
	var payload struct {
		UpdatedAt int64 `json:"updated_at"`
		Quota     map[string]struct {
			RemainingFraction *float64 `json:"remaining_fraction"`
			RemainingAmount   *float64 `json:"remaining_amount"`
			ResetTime         string   `json:"reset_time"`
			Disabled          bool     `json:"disabled"`
		} `json:"quota"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return usage
	}
	if payload.UpdatedAt <= 0 || payload.UpdatedAt > now.Add(time.Minute).Unix() || now.Sub(time.Unix(payload.UpdatedAt, 0)) > 20*time.Minute {
		return usage
	}
	keys := make([]string, 0, len(payload.Quota))
	for key := range payload.Quota {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		priority := func(key string) int {
			lower := strings.ToLower(key)
			switch {
			case strings.Contains(lower, "5h"):
				return 0
			case strings.Contains(lower, "weekly"), strings.Contains(lower, "week"):
				return 1
			default:
				return 2
			}
		}
		if priority(keys[i]) != priority(keys[j]) {
			return priority(keys[i]) < priority(keys[j])
		}
		return keys[i] < keys[j]
	})
	for _, key := range keys {
		bucket := payload.Quota[key]
		if bucket.Disabled {
			continue
		}
		window := pricingUsageWindow{Label: key, Bucket: key}
		if bucket.RemainingFraction != nil && !math.IsNaN(*bucket.RemainingFraction) && !math.IsInf(*bucket.RemainingFraction, 0) && *bucket.RemainingFraction >= 0 && *bucket.RemainingFraction <= 1 {
			remaining := *bucket.RemainingFraction * 100
			window.RemainingPercent = &remaining
		} else if bucket.RemainingAmount != nil && !math.IsNaN(*bucket.RemainingAmount) && !math.IsInf(*bucket.RemainingAmount, 0) && *bucket.RemainingAmount >= 0 {
			window.RemainingAmount = bucket.RemainingAmount
		} else {
			continue
		}
		if resetAt, parseErr := time.Parse(time.RFC3339, bucket.ResetTime); parseErr == nil {
			window.ResetAt = resetAt.Unix()
		}
		usage.Windows = append(usage.Windows, window)
	}
	if len(usage.Windows) == 0 {
		return usage
	}
	usage.Status = "ok"
	usage.UpdatedAt = payload.UpdatedAt
	return usage
}

func selectUsageSnapshotBuckets(usage pricingUsageSnapshot, bucketIDs string) pricingUsageSnapshot {
	if usage.Status != "ok" {
		return usage
	}
	selected := make(map[string]struct{})
	for part := range strings.SplitSeq(bucketIDs, ",") {
		if id := strings.TrimSpace(part); id != "" {
			selected[id] = struct{}{}
		}
	}
	filtered := unavailablePricingUsage(usage.Source)
	for _, window := range usage.Windows {
		if _, ok := selected[window.Bucket]; ok {
			filtered.Windows = append(filtered.Windows, window)
		}
	}
	if len(filtered.Windows) > 0 {
		filtered.Status = "ok"
		filtered.UpdatedAt = usage.UpdatedAt
	}
	return filtered
}
